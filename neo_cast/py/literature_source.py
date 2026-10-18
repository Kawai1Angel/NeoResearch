#!/usr/bin/env python3
"""Build a local, auditable literature source for NeoResearch.

The builder deliberately separates discovery from interpretation.  It harvests
paper metadata from version-pinned public reading lists, normalizes and
deduplicates the records, optionally enriches them with OpenAlex, and downloads
only publicly reachable PDFs.  It does not create scientific knowledge cards;
that remains the Literature Agent's job.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import dataclasses
import datetime as dt
import gzip
import hashlib
import html
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterable


USER_AGENT = "NeoResearch-Literature-Source/1.0 (+local research corpus builder)"
MARKDOWN_LINK_RE = re.compile(r"\[([^]]+)\]\(([^)]+)\)")
DECORATION_RE = re.compile(r"[⭐💛]| ")


@dataclasses.dataclass(frozen=True)
class DiscoveryRecord:
    title: str
    paper_url: str
    code_url: str | None
    venue: str
    year: int
    venue_tier: str
    pool: str
    discovered_by: str
    discovery_section: str
    source_label: str
    publication_status: str = "peer_reviewed"
    publication_track: str = "main"
    openalex: str | None = None
    doi: str | None = None
    arxiv: str | None = None
    pdf_url: str | None = None


@dataclasses.dataclass(frozen=True)
class OfficialEntry:
    source_id: str
    authority: str
    venue: str
    year: int
    track: str
    track_type: str
    record_id: str
    title: str
    landing_url: str
    pdf_url: str | None
    doi: str | None
    abstract: str | None
    snapshot_sha256: str


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def normalize_space(value: str) -> str:
    value = html.unescape(unicodedata.normalize("NFKC", value))
    value = DECORATION_RE.sub(" ", value)
    return " ".join(value.split()).strip()


def title_key(value: str) -> str:
    value = normalize_space(value).casefold()
    return re.sub(r"[^a-z0-9]+", "", value)


def stable_paper_id(title: str, year: int) -> str:
    digest = hashlib.sha256(title_key(title).encode("utf-8")).hexdigest()[:12]
    return f"tsf-{year}-{digest}"


def http_get(url: str, timeout: int = 45, attempts: int = 3) -> tuple[bytes, str, str | None]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/pdf,text/markdown,text/plain,application/json,*/*",
        },
    )
    last_error: BaseException | None = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = response.read()
                if response.headers.get("Content-Encoding", "").casefold() == "gzip" or data[:2] == b"\x1f\x8b":
                    data = gzip.decompress(data)
                return data, response.geturl(), response.headers.get("Content-Type")
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code not in {408, 429, 500, 502, 503, 504}:
                raise
        except (OSError, urllib.error.URLError) as error:
            last_error = error
        if attempt + 1 < attempts:
            retry_after = 0.0
            if isinstance(last_error, urllib.error.HTTPError):
                try:
                    retry_after = float(last_error.headers.get("Retry-After", 0))
                except (TypeError, ValueError):
                    retry_after = 0.0
            time.sleep(min(30.0, max(retry_after, 0.75 * (2**attempt))))
    assert last_error is not None
    raise last_error


def load_text(
    source: dict[str, Any],
    source_override: str | None = None,
    cache_dir: Path | None = None,
    refresh: bool = False,
) -> str:
    if source_override:
        return Path(source_override).read_text(encoding="utf-8")
    cache_path = cache_dir / f"{source['id']}-{source.get('revision', 'snapshot')}.md" if cache_dir else None
    if cache_path and cache_path.exists() and not refresh:
        return cache_path.read_text(encoding="utf-8")
    errors: list[str] = []
    urls = [*source.get("fallback_urls", []), source["snapshot_url"]]
    for url in urls:
        try:
            data, _, _ = http_get(url)
            markdown = data.decode("utf-8")
            if cache_path:
                cache_path.parent.mkdir(parents=True, exist_ok=True)
                temp = cache_path.with_suffix(cache_path.suffix + ".tmp")
                temp.write_text(markdown, encoding="utf-8")
                temp.replace(cache_path)
            return markdown
        except (OSError, UnicodeDecodeError, urllib.error.URLError) as error:
            errors.append(f"{url}: {error}")
    if cache_path and cache_path.exists():
        return cache_path.read_text(encoding="utf-8")
    raise OSError(" | ".join(errors))


def strip_markup(value: str) -> str:
    return normalize_space(re.sub(r"<[^>]+>", " ", value))


def section_bodies(markdown: str) -> dict[str, str]:
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", markdown, flags=re.MULTILINE))
    result: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        result[normalize_space(match.group(1))] = markdown[match.end() : end]
    return result


def parse_venue_year(
    source_label: str,
    venue_aliases: dict[str, str],
    venue_tiers: dict[str, list[str]],
) -> tuple[str, int, str] | None:
    normalized = normalize_space(source_label)
    # Reading lists sometimes mix workshop papers into the main-conference
    # section.  The source policy is intentionally limited to proceedings of
    # the named venues, so do not silently promote workshop papers.
    if re.search(r"\bworkshops?\b", normalized, flags=re.IGNORECASE):
        return None
    aliases = sorted(venue_aliases, key=len, reverse=True)
    pattern = r"\b(" + "|".join(re.escape(item) for item in aliases) + r")\b[^0-9]*(20\d{2})"
    match = re.search(pattern, normalized, flags=re.IGNORECASE)
    if not match:
        return None
    alias_lookup = {key.casefold(): value for key, value in venue_aliases.items()}
    venue = alias_lookup[match.group(1).casefold()]
    year = int(match.group(2))
    tier = next((name for name, venues in venue_tiers.items() if venue in venues), "unranked")
    return venue, year, tier


def parse_tsc_table_source(markdown: str, source: dict[str, Any], config: dict[str, Any]) -> list[DiscoveryRecord]:
    sections = section_bodies(markdown)
    configured_sections = config["policy"]["sections"]
    venue_aliases = config["venue_aliases"]
    venue_tiers = config["venue_tiers"]
    records: list[DiscoveryRecord] = []

    for section_name, pool in configured_sections.items():
        body = sections.get(section_name)
        if not body:
            continue
        for raw_line in body.splitlines():
            if not raw_line.startswith("|"):
                continue
            cells = [cell.strip() for cell in raw_line.strip().strip("|").split("|")]
            if len(cells) < 3 or not cells[0].startswith("["):
                continue
            paper_link = MARKDOWN_LINK_RE.search(cells[0])
            if not paper_link:
                continue
            venue_year = parse_venue_year(cells[-1], venue_aliases, venue_tiers)
            if not venue_year:
                continue
            venue, year, tier = venue_year
            code_link = MARKDOWN_LINK_RE.search(cells[1])
            title = correct_title(normalize_space(paper_link.group(1)), config)
            if pool not in {"core", "accepted_core"} and not is_adjacent_relevant(title, section_name):
                continue
            records.append(
                DiscoveryRecord(
                    title=title,
                    paper_url=paper_link.group(2).strip(),
                    code_url=code_link.group(2).strip() if code_link else None,
                    venue=venue,
                    year=year,
                    venue_tier=tier,
                    pool=pool,
                    discovered_by=source["id"],
                    discovery_section=section_name,
                    source_label=normalize_space(cells[-1]),
                )
            )
    return records


def parse_bullet_source(markdown: str, source: dict[str, Any], config: dict[str, Any]) -> list[DiscoveryRecord]:
    records: list[DiscoveryRecord] = []
    venue_aliases = config["venue_aliases"]
    venue_tiers = config["venue_tiers"]
    for raw_line in markdown.splitlines():
        if not raw_line.lstrip().startswith("*") or "[\\[Paper\\]]" not in raw_line:
            continue
        paper_match = re.search(r"\[\\\[Paper\\\]\]\(([^)]+)\)", raw_line)
        if not paper_match:
            continue
        prefix = raw_line.lstrip("* ").split(", in ", 1)
        if len(prefix) != 2:
            continue
        title = correct_title(normalize_space(prefix[0]), config)
        if "forecast" not in title.casefold():
            continue
        venue_year = parse_venue_year(prefix[1], venue_aliases, venue_tiers)
        if not venue_year:
            continue
        venue, year, tier = venue_year
        code_match = re.search(r"\[\\\[Code\\\]\]\(([^)]+)\)", raw_line)
        records.append(
            DiscoveryRecord(
                title=title,
                paper_url=paper_match.group(1),
                code_url=code_match.group(1) if code_match else None,
                venue=venue,
                year=year,
                venue_tier=tier,
                pool="accepted_core",
                discovered_by=source["id"],
                discovery_section="forecast-title-match",
                source_label=f"{venue} {year}",
            )
        )
    return records


def external_pool(title: str, model_name: str, config: dict[str, Any]) -> str | None:
    """Return the explicitly curated pool for non-target-venue discoveries."""
    normalized = f"{model_name} {title}".casefold()
    for name, pool in config.get("external_title_classification", {}).items():
        if name.casefold() in normalized:
            return pool
    return None


def discovery_record_from_markdown_entry(
    *,
    title: str,
    model_name: str,
    paper_url: str,
    code_url: str | None,
    source_label: str,
    section: str,
    source: dict[str, Any],
    config: dict[str, Any],
) -> DiscoveryRecord | None:
    venue_year = parse_venue_year(source_label, config["venue_aliases"], config["venue_tiers"])
    if venue_year:
        venue, year, tier = venue_year
        pool = config.get("title_pool_overrides", {}).get(title)
        if not pool:
            pool = (
                "accepted_core"
                if is_official_relevant(title, None) == "accepted_core"
                else "accepted_adjacent"
            )
        return DiscoveryRecord(
            title=correct_title(title, config),
            paper_url=paper_url,
            code_url=code_url,
            venue=venue,
            year=year,
            venue_tier=tier,
            pool=pool,
            discovered_by=source["id"],
            discovery_section=section,
            source_label=normalize_space(source_label),
        )

    year_match = re.search(r"\b(20\d{2})\b", source_label)
    pool = external_pool(title, model_name, config)
    if not year_match or not pool:
        return None
    venue_match = re.search(r"([A-Za-z][A-Za-z0-9 .&+-]*?)\s*,?\s*20\d{2}", source_label)
    venue = normalize_space(venue_match.group(1)) if venue_match else "arXiv"
    status = "preprint" if venue.casefold() == "arxiv" else "peer_reviewed"
    return DiscoveryRecord(
        title=correct_title(title, config),
        paper_url=paper_url,
        code_url=code_url,
        venue=venue,
        year=int(year_match.group(1)),
        venue_tier="unranked",
        pool=pool,
        discovered_by=source["id"],
        discovery_section=section,
        source_label=normalize_space(source_label),
        publication_status=status,
        publication_track="preprint" if status == "preprint" else "external",
    )


def parse_tongji_source(
    markdown: str, source: dict[str, Any], config: dict[str, Any]
) -> list[DiscoveryRecord]:
    """Parse TongjiFinLab's multi-line paper bullets without trusting venue claims."""
    records: list[DiscoveryRecord] = []
    heading = "unsectioned"
    lines = markdown.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        if line.startswith("#"):
            heading = normalize_space(line.lstrip("# ").replace("<!-- omit in toc -->", ""))
        title_match = re.match(r"\s*-\s+\*\*(.+?)\*\*\s*$", line)
        if not title_match:
            index += 1
            continue
        title = normalize_space(title_match.group(1))
        block: list[str] = []
        cursor = index + 1
        while cursor < len(lines) and not re.match(r"\s*-\s+\*\*", lines[cursor]):
            if lines[cursor].startswith("#"):
                break
            block.append(lines[cursor])
            cursor += 1
            if len(block) >= 12:
                break
        block_text = "\n".join(block)
        paper_match = re.search(r"\[Paper\]\(([^)]+)\)", block_text, flags=re.IGNORECASE)
        if paper_match:
            code_match = re.search(r"\[Code\]\(([^)]+)\)", block_text, flags=re.IGNORECASE)
            label = next(
                (
                    normalize_space(item.strip().rstrip("."))
                    for item in block
                    if re.search(r"\b20\d{2}\b", item)
                ),
                "",
            )
            record = discovery_record_from_markdown_entry(
                title=title,
                model_name=title.split(":", 1)[0],
                paper_url=paper_match.group(1).strip(),
                code_url=code_match.group(1).strip() if code_match else None,
                source_label=label,
                section=heading,
                source=source,
                config=config,
            )
            if record:
                records.append(record)
        index = max(index + 1, cursor)
    return records


def parse_thuml_source(
    markdown: str, source: dict[str, Any], config: dict[str, Any]
) -> list[DiscoveryRecord]:
    """Parse the checked model inventory in THUML Time-Series-Library."""
    records: list[DiscoveryRecord] = []
    heading = "model inventory"
    pattern = re.compile(
        r"^\s*-\s+\[[ xX]\]\s+\*\*(.+?)\*\*\s+-\s+(.+?)\s+"
        r"\[\[([^]]+)\]\]\(([^)]+)\)(.*)$"
    )
    for line in markdown.splitlines():
        if line.startswith("#"):
            heading = normalize_space(line.lstrip("# "))
        match = pattern.match(line)
        if not match:
            continue
        model_name, title, source_label, paper_url, suffix = match.groups()
        code_match = re.search(r"\[\[Code\]\]\(([^)]+)\)", suffix, flags=re.IGNORECASE)
        record = discovery_record_from_markdown_entry(
            title=normalize_space(title),
            model_name=normalize_space(model_name),
            paper_url=paper_url.strip(),
            code_url=code_match.group(1).strip() if code_match else None,
            source_label=source_label,
            section=heading,
            source=source,
            config=config,
        )
        if record:
            records.append(record)
    return records


def correct_title(title: str, config: dict[str, Any]) -> str:
    """Apply small, auditable corrections to upstream-list transcription errors."""
    corrections = config.get("title_corrections", {})
    return corrections.get(title, title)


def historical_foundation_match(
    title: str, year: int, config: dict[str, Any]
) -> dict[str, Any] | None:
    """Return the explicitly curated pre-boundary record matching a title."""
    expected = title_key(title)
    for record in (config.get("historical_foundations") or {}).get("records", []):
        if int(record["year"]) != year:
            continue
        names = [record["title"], *record.get("aliases", [])]
        if expected in {title_key(name) for name in names}:
            return record
    return None


def historical_discovery_records(config: dict[str, Any]) -> list[DiscoveryRecord]:
    """Materialize the reviewed historical manifest as a discovery source."""
    historical = config.get("historical_foundations") or {}
    source_id = historical.get("source_id", "curated_historical_foundations")
    output: list[DiscoveryRecord] = []
    for record in historical.get("records", []):
        output.append(
            DiscoveryRecord(
                title=correct_title(record["title"], config),
                paper_url=record["paper_url"],
                code_url=record.get("code_url"),
                venue=record["venue"],
                year=int(record["year"]),
                venue_tier=record.get("venue_tier", "unranked"),
                pool="historical_foundation",
                discovered_by=source_id,
                discovery_section=record["category"],
                source_label=record.get(
                    "source_label", f"{record['venue']} {record['year']}"
                ),
                publication_status=record.get("publication_status", "peer_reviewed"),
                publication_track=record.get("publication_track", "main"),
                doi=record.get("doi"),
                arxiv=record.get("arxiv"),
                pdf_url=record.get("pdf_url"),
            )
        )
    return output


def is_adjacent_relevant(title: str, section_name: str) -> bool:
    lowered = title.casefold()
    if "forecast" in lowered:
        return True
    if section_name == "Time Series Foundation Model":
        task_specific_non_forecasting = (
            "classification",
            "anomaly detection",
            "imputation",
            "generation",
            "question answering",
            "understanding",
        )
        if any(term in lowered for term in task_specific_non_forecasting):
            return False
        return any(term in lowered for term in ("foundation model", "time series model", "time-series model"))
    return any(term in lowered for term in ("forecasting", "predictive", "multivariate time series"))


def apply_policy(records: Iterable[DiscoveryRecord], config: dict[str, Any]) -> list[DiscoveryRecord]:
    policy = config["policy"]
    include_tiers = set(policy["include_tiers"])
    output: list[DiscoveryRecord] = []
    for record in records:
        historical = historical_foundation_match(record.title, record.year, config)
        if historical:
            output.append(dataclasses.replace(record, pool="historical_foundation"))
            continue
        if record.year >= policy["start_year"] and (
            record.venue_tier in include_tiers
            or record.pool in {"influential_external", "watchlist"}
        ):
            output.append(record)
    return output


def deduplicate(records: Iterable[DiscoveryRecord]) -> list[dict[str, Any]]:
    """Deduplicate by identifiers, normalized title, and conservative fuzzy title matching."""
    grouped: list[list[DiscoveryRecord]] = []
    for record in records:
        matching_group: list[DiscoveryRecord] | None = None
        for group in grouped:
            primary = group[0]
            same_identifier = bool(
                (record.doi and any(record.doi == item.doi for item in group))
                or (record.arxiv and any(record.arxiv == item.arxiv for item in group))
            )
            same_title = title_key(record.title) == title_key(primary.title)
            fuzzy_title = (
                record.year == primary.year
                and record.venue == primary.venue
                and SequenceMatcher(
                    None, title_key(record.title), title_key(primary.title)
                ).ratio()
                >= 0.97
            )
            if same_identifier or same_title or fuzzy_title:
                matching_group = group
                break
        if matching_group is None:
            grouped.append([record])
        else:
            matching_group.append(record)

    output: list[dict[str, Any]] = []
    pool_order = {
        "historical_foundation": 0,
        "accepted_core": 1,
        "accepted_adjacent": 2,
        "influential_external": 3,
        "watchlist": 4,
    }
    for group in grouped:
        group.sort(key=lambda item: (pool_order.get(item.pool, 9), item.venue_tier, item.year))
        primary = group[0]
        urls = list(
            dict.fromkeys(
                [item.paper_url for item in group]
                + [item.pdf_url for item in group if item.pdf_url]
            )
        )
        code_urls = list(dict.fromkeys(item.code_url for item in group if item.code_url))
        sources = [
            {
                "source_id": item.discovered_by,
                "section": item.discovery_section,
                "source_label": item.source_label,
                "paper_url": item.paper_url,
            }
            for item in group
        ]
        output.append(
            {
                "paper_id": stable_paper_id(primary.title, primary.year),
                "title": primary.title,
                "year": primary.year,
                "venue": primary.venue,
                "venue_tier": primary.venue_tier,
                "pool": min((item.pool for item in group), key=lambda value: pool_order.get(value, 9)),
                "publication_status": primary.publication_status,
                "publication_track": primary.publication_track,
                "publication_verification": (
                    "unverified_external"
                    if primary.pool in {"influential_external", "watchlist"}
                    or primary.publication_status != "peer_reviewed"
                    else "curated_venue_claim"
                ),
                "official_proceedings": None,
                "paper_urls": urls,
                "code_urls": code_urls,
                "discovery_sources": sources,
                "identifiers": {
                    "openalex": next((item.openalex for item in group if item.openalex), None),
                    "doi": next((item.doi for item in group if item.doi), None),
                    "arxiv": next((item.arxiv for item in group if item.arxiv), None)
                    or arxiv_id_from_urls(urls),
                },
                "open_access": {
                    "is_oa": True if any(item.pdf_url for item in group) else None,
                    "oa_status": "green" if any(item.pdf_url for item in group) else None,
                    "pdf_url": next(
                        (item.pdf_url for item in group if item.pdf_url),
                        direct_pdf_url(urls[0]),
                    ),
                },
                "download": {
                    "status": "not_attempted",
                    "path": None,
                    "source_url": None,
                    "final_url": None,
                    "sha256": None,
                    "bytes": None,
                    "error": None,
                },
            }
        )
    return sorted(output, key=lambda item: (-item["year"], item["venue"], item["title"].casefold()))


def arxiv_id_from_urls(urls: Iterable[str]) -> str | None:
    for url in urls:
        match = re.search(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})(?:v\d+)?", url, re.IGNORECASE)
        if match:
            return match.group(1)
    return None


def direct_pdf_url(url: str) -> str | None:
    parsed = urllib.parse.urlparse(url)
    host = parsed.netloc.casefold()
    if "arxiv.org" in host:
        match = re.search(r"/(?:abs|pdf)/(\d{4}\.\d{4,5}(?:v\d+)?)", parsed.path, re.IGNORECASE)
        return f"https://arxiv.org/pdf/{match.group(1)}" if match else None
    if "openreview.net" in host:
        query = urllib.parse.parse_qs(parsed.query)
        if "id" in query:
            return "https://openreview.net/pdf?id=" + urllib.parse.quote(query["id"][0])
        if parsed.path.casefold().endswith(".pdf"):
            return url
        return None
    if parsed.path.casefold().endswith(".pdf"):
        return url
    return None


def openalex_cache_path(cache_dir: Path, paper: dict[str, Any]) -> Path:
    digest = hashlib.sha256(title_key(paper["title"]).encode("utf-8")).hexdigest()
    return cache_dir / f"{digest}.json"


def enrich_openalex(paper: dict[str, Any], cache_dir: Path, timeout: int = 45) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = openalex_cache_path(cache_dir, paper)
    if cache_path.exists():
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    else:
        api_key = os.environ.get("OPENALEX_API_KEY")
        if not api_key:
            raise OSError(
                "OPENALEX_API_KEY is required for uncached OpenAlex requests; "
                "cached enrichment remains available without a key."
            )
        # OpenAlex's full-text query parser treats punctuation such as a final
        # question mark as syntax.  Searching normalized words avoids 400s for
        # perfectly valid paper titles.
        search_title = re.sub(r"[^\w\s-]+", " ", paper["title"], flags=re.UNICODE)
        query = urllib.parse.urlencode(
            {
                "search": normalize_space(search_title),
                "per-page": 5,
                "select": "id,doi,title,publication_year,primary_location,best_oa_location,open_access,locations",
                "api_key": api_key,
            }
        )
        data, _, _ = http_get(f"https://api.openalex.org/works?{query}", timeout=timeout)
        payload = json.loads(data)
        cache_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    candidates = payload.get("results", [])
    if not candidates:
        return
    expected = title_key(paper["title"])
    best = max(candidates, key=lambda item: SequenceMatcher(None, expected, title_key(item.get("title", ""))).ratio())
    similarity = SequenceMatcher(None, expected, title_key(best.get("title", ""))).ratio()
    if similarity < 0.9:
        return

    paper["identifiers"]["openalex"] = best.get("id")
    doi = best.get("doi")
    paper["identifiers"]["doi"] = doi.removeprefix("https://doi.org/") if isinstance(doi, str) else None
    access = best.get("open_access") or {}
    best_oa = best.get("best_oa_location") or {}
    paper["open_access"]["is_oa"] = access.get("is_oa")
    paper["open_access"]["oa_status"] = access.get("oa_status")
    pdf_url = choose_openalex_pdf(best)

    # Older caches predate the `locations` field. Fetch it only for records
    # whose current public URL is absent or blocked by OpenReview in some
    # environments; this keeps normal rebuilds light on the public API.
    current_pdf = pdf_url or paper["open_access"].get("pdf_url")
    needs_locations = not best.get("locations") and (
        not current_pdf or "openreview.net" in urllib.parse.urlparse(current_pdf).netloc.casefold()
    )
    if needs_locations and best.get("id"):
        work_id = str(best["id"]).rsplit("/", 1)[-1]
        detail_path = cache_dir / f"{work_id}.locations.json"
        if detail_path.exists():
            detail = json.loads(detail_path.read_text(encoding="utf-8"))
        else:
            api_key = os.environ.get("OPENALEX_API_KEY")
            if not api_key:
                return
            detail_query = urllib.parse.urlencode(
                {
                    "select": "id,title,doi,best_oa_location,open_access,locations",
                    "api_key": api_key,
                }
            )
            detail_data, _, _ = http_get(
                f"https://api.openalex.org/works/{urllib.parse.quote(work_id)}?{detail_query}",
                timeout=timeout,
            )
            detail = json.loads(detail_data)
            detail_path.write_text(json.dumps(detail, ensure_ascii=False), encoding="utf-8")
        pdf_url = choose_openalex_pdf(detail) or pdf_url

    if pdf_url:
        paper["open_access"]["pdf_url"] = pdf_url
        arxiv_id = arxiv_id_from_urls([pdf_url])
        if arxiv_id:
            paper["identifiers"]["arxiv"] = arxiv_id


def choose_openalex_pdf(work: dict[str, Any]) -> str | None:
    """Prefer stable public repositories over conference attachment hosts."""
    urls: list[str] = []
    best_oa = work.get("best_oa_location") or {}
    if best_oa.get("pdf_url"):
        urls.append(best_oa["pdf_url"])
    for location in work.get("locations") or []:
        if location.get("pdf_url"):
            urls.append(location["pdf_url"])
    urls = list(dict.fromkeys(urls))
    if not urls:
        return None

    def priority(url: str) -> tuple[int, str]:
        host = urllib.parse.urlparse(url).netloc.casefold()
        if "arxiv.org" in host:
            return (0, url)
        if "proceedings.mlr.press" in host or "neurips.cc" in host:
            return (1, url)
        if "openreview.net" in host or "dl.acm.org" in host:
            return (3, url)
        return (2, url)

    return min(urls, key=priority)


def is_official_relevant(title: str, abstract: str | None) -> str | None:
    """Conservative title/abstract screening for forecasting-related official records."""
    text = normalize_space(f"{title} {abstract or ''}").casefold()
    core_phrases = (
        "time series forecast",
        "time-series forecast",
        "time series prediction",
        "time-series prediction",
        "temporal forecasting",
        "probabilistic forecasting",
        "spatio-temporal forecast",
        "spatiotemporal forecast",
        "spatio-temporal prediction",
        "spatiotemporal prediction",
        "traffic forecast",
        "demand forecast",
        "load forecast",
    )
    if any(phrase in text for phrase in core_phrases):
        return "accepted_core"
    adjacent_phrases = (
        "time series foundation model",
        "time-series foundation model",
        "foundation model for time series",
        "foundation models for time series",
        "non-stationary time series",
        "nonstationary time series",
        "time series distribution shift",
        "time-series distribution shift",
        "time series concept drift",
        "time-series concept drift",
        "time series calibration",
        "time-series calibration",
        "time series benchmark",
        "time-series benchmark",
    )
    if any(phrase in text for phrase in adjacent_phrases):
        return "accepted_adjacent"
    return None


def parse_aaai_archive(index_html: str) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    pattern = re.compile(
        r'<a\s+class="title"\s+href="([^"]+/issue/view/(\d+))">(.*?)</a>',
        flags=re.IGNORECASE | re.DOTALL,
    )
    for url, issue_id, raw_title in pattern.findall(index_html):
        issues.append({"url": html.unescape(url), "record_id": issue_id, "title": strip_markup(raw_title)})
    return issues


def parse_aaai_issue(index_html: str, base_url: str) -> list[dict[str, str | None]]:
    entries: list[dict[str, str | None]] = []
    headings = list(re.finditer(r"<h2[^>]*>(.*?)</h2>", index_html, flags=re.IGNORECASE | re.DOTALL))
    for heading_index, heading in enumerate(headings):
        track = strip_markup(heading.group(1))
        end = headings[heading_index + 1].start() if heading_index + 1 < len(headings) else len(index_html)
        section = index_html[heading.end() : end]
        articles = list(
            re.finditer(
                r'<h3\s+class="title">(.*?)</h3>', section, flags=re.IGNORECASE | re.DOTALL
            )
        )
        for article_index, article in enumerate(articles):
            block_end = articles[article_index + 1].start() if article_index + 1 < len(articles) else len(section)
            block = article.group(1) + section[article.end() : block_end]
            landing_match = re.search(
                r'href="([^"]+/article/view/(\d+))"', block, flags=re.IGNORECASE
            )
            if not landing_match:
                continue
            title = strip_markup(article.group(1))
            pdf_matches = re.findall(
                r'href="([^"]+/article/view/\d+/\d+)"', block, flags=re.IGNORECASE
            )
            entries.append(
                {
                    "title": title,
                    "landing_url": urllib.parse.urljoin(base_url, html.unescape(landing_match.group(1))),
                    "pdf_url": (
                        urllib.parse.urljoin(base_url, html.unescape(pdf_matches[0]))
                        if pdf_matches
                        else None
                    ),
                    "track": track,
                    "record_id": landing_match.group(2),
                }
            )
    return entries


def parse_ijcai_index(index_html: str, base_url: str) -> list[dict[str, str | None]]:
    entries: list[dict[str, str | None]] = []
    sections = list(
        re.finditer(
            r'<div\s+class="section"[^>]*>\s*<div\s+class="section_title">\s*<h3>(.*?)</h3>',
            index_html,
            flags=re.IGNORECASE | re.DOTALL,
        )
    )
    for section_index, section_match in enumerate(sections):
        track = strip_markup(section_match.group(1))
        end = sections[section_index + 1].start() if section_index + 1 < len(sections) else len(index_html)
        section = index_html[section_match.end() : end]
        pattern = re.compile(
            r'<div\s+id="paper(\d+)"\s+class="paper_wrapper">'
            r'.*?<div\s+class="title">(.*?)</div>'
            r'.*?<div\s+class="details">(.*?)</div>',
            flags=re.IGNORECASE | re.DOTALL,
        )
        for record_id, raw_title, details in pattern.findall(section):
            pdf_match = re.search(r'href="([^"]+\.pdf)"', details, flags=re.IGNORECASE)
            landing_match = re.search(r'href="([^"]*/proceedings/\d+/\d+)"', details, flags=re.IGNORECASE)
            pdf_url = urllib.parse.urljoin(base_url, pdf_match.group(1)) if pdf_match else None
            landing_url = (
                urllib.parse.urljoin(base_url, landing_match.group(1))
                if landing_match
                else pdf_url or base_url
            )
            entries.append(
                {
                    "title": strip_markup(raw_title),
                    "landing_url": landing_url,
                    "pdf_url": pdf_url,
                    "track": track,
                    "record_id": record_id,
                }
            )
    return entries


def parse_pvldb_index(index_html: str, base_url: str) -> list[dict[str, str | None]]:
    entries: list[dict[str, str | None]] = []
    seen: set[str] = set()
    decoder = json.JSONDecoder()
    cursor = 0
    while True:
        start = index_html.find('{"issue":', cursor)
        if start < 0:
            break
        try:
            item, consumed = decoder.raw_decode(index_html[start:])
        except json.JSONDecodeError:
            cursor = start + 1
            continue
        cursor = start + consumed
        if not isinstance(item, dict) or not item.get("pdf") or not item.get("title"):
            continue
        pdf_url = urllib.parse.urljoin(base_url, html.unescape(str(item["pdf"])))
        if pdf_url in seen:
            continue
        seen.add(pdf_url)
        entries.append(
            {
                "title": normalize_space(str(item["title"])),
                "landing_url": pdf_url,
                "pdf_url": pdf_url,
                "track": f"PVLDB issue {item['issue']}",
                "record_id": Path(urllib.parse.urlparse(pdf_url).path).stem,
            }
        )
    return entries


def parse_crossref_items(
    payload: dict[str, Any], source: dict[str, Any], year: int
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    container_pattern = re.compile(
        source["container_regex_template"].format(year=year), flags=re.IGNORECASE
    )
    for item in payload.get("message", {}).get("items", []):
        publisher = normalize_space(str(item.get("publisher", "")))
        if source.get("publisher") and publisher.casefold() != source["publisher"].casefold():
            continue
        container = " | ".join(item.get("container-title") or [])
        if not container_pattern.search(container):
            continue
        titles = item.get("title") or []
        doi = item.get("DOI")
        if not titles or not doi:
            continue
        entries.append(
            {
                "title": strip_markup(str(titles[0])),
                "landing_url": item.get("URL") or f"https://doi.org/{doi}",
                "pdf_url": None,
                "track": "Main proceedings",
                "record_id": doi,
                "doi": doi,
                "abstract": strip_markup(item["abstract"]) if item.get("abstract") else None,
            }
        )
    return entries


def parse_hash_index(index_html: str, base_url: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    pattern = re.compile(
        r'<a\s+title="paper title"\s+href="([^"]+)">(.*?)</a>',
        flags=re.IGNORECASE | re.DOTALL,
    )
    for href, raw_title in pattern.findall(index_html):
        title = normalize_space(re.sub(r"<[^>]+>", " ", raw_title))
        landing_url = urllib.parse.urljoin(base_url, html.unescape(href))
        suffix_match = re.search(r"-Abstract(?:-([A-Za-z0-9_]+))?\.html$", landing_url)
        if not suffix_match:
            continue
        suffix = suffix_match.group(1)
        track_names = {
            "Conference": "Main Conference Track",
            "Datasets_and_Benchmarks_Track": "Datasets and Benchmarks Track",
            "Position_Paper_Track": "Position Paper Track",
        }
        if suffix is not None and suffix not in track_names:
            continue
        if suffix is None:
            pdf_url = landing_url.replace("/hash/", "/file/").replace(
                "-Abstract.html", "-Paper.pdf"
            )
            track = "Main Conference Track"
        else:
            pdf_url = landing_url.replace("/hash/", "/file/").replace(
                f"-Abstract-{suffix}.html", f"-Paper-{suffix}.pdf"
            )
            track = track_names[suffix]
        record_id_match = re.search(r"/hash/([a-f0-9]+)-Abstract-", landing_url, re.IGNORECASE)
        if not record_id_match:
            record_id_match = re.search(
                r"/hash/([a-f0-9]+)-Abstract\.html$", landing_url, re.IGNORECASE
            )
        entries.append(
            {
                "title": title,
                "landing_url": landing_url,
                "pdf_url": pdf_url,
                "track": track,
                "record_id": record_id_match.group(1) if record_id_match else title_key(title),
            }
        )
    return entries


def parse_pmlr_index(index_html: str, base_url: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    blocks = re.findall(
        r'<div\s+class="paper">(.*?)</div>', index_html, flags=re.DOTALL | re.IGNORECASE
    )
    for block in blocks:
        title_match = re.search(
            r'<p\s+class="title">(.*?)</p>', block, flags=re.DOTALL | re.IGNORECASE
        )
        if not title_match:
            continue
        title = normalize_space(re.sub(r"<[^>]+>", " ", title_match.group(1)))
        urls = [
            urllib.parse.urljoin(base_url, html.unescape(url))
            for url in re.findall(r'href="([^"]+)"', block)
        ]
        landing_url = next(
            (url for url in urls if "proceedings.mlr.press" in url and url.endswith(".html")),
            None,
        )
        pdf_url = next((url for url in urls if url.endswith(".pdf")), None)
        if landing_url and pdf_url:
            entries.append({"title": title, "landing_url": landing_url, "pdf_url": pdf_url})
    return entries


# Kept as a public alias for callers of the first builder version.
parse_iclr_index = parse_hash_index


def cached_text(url: str, cache_path: Path, refresh: bool = False) -> str:
    if cache_path.exists() and not refresh:
        return cache_path.read_text(encoding="utf-8")
    data, _, _ = http_get(url, timeout=90)
    text = data.decode("utf-8")
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temp = cache_path.with_suffix(cache_path.suffix + ".tmp")
    temp.write_text(text, encoding="utf-8")
    temp.replace(cache_path)
    return text


def official_entry(
    source: dict[str, Any],
    year: int,
    raw: dict[str, Any],
    snapshot_sha256: str,
) -> OfficialEntry:
    track = normalize_space(str(raw.get("track") or source.get("track") or "Main proceedings"))
    track_type = "main"
    if re.search(r"\b(workshop|student abstract|demonstration)\b", track, flags=re.IGNORECASE):
        track_type = "workshop"
    elif not re.search(r"\b(main|technical|research|PVLDB)\b", track, flags=re.IGNORECASE):
        track_type = "special"
    return OfficialEntry(
        source_id=source["id"],
        authority=source.get("verification", "official_proceedings"),
        venue=source["venue"],
        year=year,
        track=track,
        track_type=track_type,
        record_id=str(raw["record_id"]),
        title=normalize_space(str(raw["title"])),
        landing_url=str(raw["landing_url"]),
        pdf_url=str(raw["pdf_url"]) if raw.get("pdf_url") else None,
        doi=str(raw["doi"]).casefold() if raw.get("doi") else None,
        abstract=str(raw["abstract"]) if raw.get("abstract") else None,
        snapshot_sha256=snapshot_sha256,
    )


def scan_aaai_source(
    source: dict[str, Any], cache_dir: Path, refresh: bool
) -> tuple[list[OfficialEntry], list[dict[str, Any]]]:
    entries: list[OfficialEntry] = []
    snapshots: list[dict[str, Any]] = []
    issues: list[dict[str, str]] = []
    for page in source["archive_pages"]:
        url = source["archive_url_template"].format(page=page)
        index_html = cached_text(
            url, cache_dir / f"{source['id']}-archive-{page}.html", refresh
        )
        issues.extend(parse_aaai_archive(index_html))

    for year in source["years"]:
        short_year = str(year)[-2:]
        year_issues = [
            issue
            for issue in issues
            if issue["title"].startswith(f"AAAI-{short_year}")
            and not re.search(r"student|undergraduate|demonstration|IAAI|EAAI", issue["title"], re.I)
        ]
        if not year_issues:
            snapshots.append(
                {
                    "source_id": source["id"],
                    "venue": source["venue"],
                    "year": year,
                    "status": "not_found",
                    "snapshot_url": source["archive_url_template"].format(page=1),
                    "sha256": None,
                    "records_in_index": 0,
                    "records_matched": 0,
                    "relevant_records_discovered": 0,
                    "error": "No matching AAAI issue was found in configured archive pages.",
                }
            )
            continue
        for issue in year_issues:
            issue_html = cached_text(
                issue["url"],
                cache_dir / f"{source['id']}-{year}-issue-{issue['record_id']}.html",
                refresh,
            )
            checksum = hashlib.sha256(issue_html.encode("utf-8")).hexdigest()
            raw_entries = parse_aaai_issue(issue_html, source["base_url"])
            issue_entries = [official_entry(source, year, raw, checksum) for raw in raw_entries]
            entries.extend(issue_entries)
            snapshots.append(
                {
                    "source_id": source["id"],
                    "venue": source["venue"],
                    "year": year,
                    "status": "scanned",
                    "snapshot_url": issue["url"],
                    "sha256": checksum,
                    "records_in_index": len(issue_entries),
                    "records_matched": 0,
                    "relevant_records_discovered": 0,
                    "error": None,
                }
            )
    return entries, snapshots


def year_locators(source: dict[str, Any]) -> list[tuple[int, dict[str, Any]]]:
    if "volumes" in source:
        return [(int(year), {"volume": volume}) for year, volume in source["volumes"].items()]
    return [(int(year), {}) for year in source["years"]]


def scan_simple_source(
    source: dict[str, Any], cache_dir: Path, refresh: bool
) -> tuple[list[OfficialEntry], list[dict[str, Any]]]:
    entries: list[OfficialEntry] = []
    snapshots: list[dict[str, Any]] = []
    for year, locator in year_locators(source):
        index_url = source.get("api_url", "")
        if source["parser"] != "crossref_query":
            index_url = source.get("index_urls", {}).get(str(year)) or source[
                "index_url_template"
            ].format(year=year, **locator)
        suffix = "json" if source["parser"] == "crossref_query" else "html"
        cache_path = cache_dir / f"{source['id']}-{year}.{suffix}"
        try:
            if source["parser"] == "crossref_query":
                params = {
                    "filter": (
                        f"from-pub-date:{year}-01-01,until-pub-date:{year}-12-31,"
                        f"type:{source.get('work_type', 'proceedings-article')},"
                        f"prefix:{source['prefix']}"
                    ),
                    "query.container-title": source["query_template"].format(year=year),
                    "rows": source.get("rows", 1000),
                    "select": "DOI,title,URL,publisher,container-title,published,abstract",
                }
                index_url = source["api_url"] + "?" + urllib.parse.urlencode(params)
            index_text = cached_text(index_url, cache_path, refresh)
            checksum = hashlib.sha256(index_text.encode("utf-8")).hexdigest()
            parser = source["parser"]
            if parser == "pmlr_index":
                raw_entries = parse_pmlr_index(index_text, source["base_url"])
            elif parser in {"hash_index", "iclr_index"}:
                raw_entries = parse_hash_index(index_text, source["base_url"])
            elif parser == "ijcai_index":
                raw_entries = parse_ijcai_index(index_text, index_url)
            elif parser == "pvldb_index":
                raw_entries = parse_pvldb_index(index_text, index_url)
            elif parser == "crossref_query":
                raw_entries = parse_crossref_items(json.loads(index_text), source, year)
            else:
                raise ValueError(f"Unsupported proceedings parser: {parser}")
            normalized: list[OfficialEntry] = []
            for raw_index, raw in enumerate(raw_entries):
                raw.setdefault("record_id", raw.get("doi") or f"{year}-{raw_index + 1}")
                raw.setdefault("track", source.get("track", "Main proceedings"))
                normalized.append(official_entry(source, year, raw, checksum))
            entries.extend(normalized)
            snapshots.append(
                {
                    "source_id": source["id"],
                    "venue": source["venue"],
                    "year": year,
                    "status": "scanned",
                    "snapshot_url": index_url,
                    "sha256": checksum,
                    "records_in_index": len(normalized),
                    "records_matched": 0,
                    "relevant_records_discovered": 0,
                    "error": None,
                }
            )
        except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError) as error:
            snapshots.append(
                {
                    "source_id": source["id"],
                    "venue": source["venue"],
                    "year": year,
                    "status": "failed",
                    "snapshot_url": index_url,
                    "sha256": None,
                    "records_in_index": 0,
                    "records_matched": 0,
                    "relevant_records_discovered": 0,
                    "error": str(error)[:1000],
                }
            )
    return entries, snapshots


def scan_official_sources(
    config: dict[str, Any], cache_dir: Path, refresh: bool = False
) -> tuple[list[OfficialEntry], list[dict[str, Any]]]:
    cache_dir.mkdir(parents=True, exist_ok=True)
    all_entries: list[OfficialEntry] = []
    all_snapshots: list[dict[str, Any]] = []
    for source in config.get("official_proceedings_sources", []):
        try:
            if source["parser"] == "aaai_ojs":
                entries, snapshots = scan_aaai_source(source, cache_dir, refresh)
            else:
                entries, snapshots = scan_simple_source(source, cache_dir, refresh)
        except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError) as error:
            entries = []
            snapshots = [
                {
                    "source_id": source["id"],
                    "venue": source["venue"],
                    "year": year,
                    "status": "failed",
                    "snapshot_url": source.get("index_url_template") or source.get("api_url"),
                    "sha256": None,
                    "records_in_index": 0,
                    "records_matched": 0,
                    "relevant_records_discovered": 0,
                    "error": str(error)[:1000],
                }
                for year, _ in year_locators(source)
            ]
        all_entries.extend(entries)
        all_snapshots.extend(snapshots)
        print(
            f"proceedings source={source['id']} entries={len(entries)} "
            f"snapshots={len(snapshots)} failures={sum(s['status'] != 'scanned' for s in snapshots)}",
            flush=True,
        )
    return all_entries, all_snapshots


def official_discovery_records(
    entries: Iterable[OfficialEntry], config: dict[str, Any]
) -> list[DiscoveryRecord]:
    records: list[DiscoveryRecord] = []
    for entry in entries:
        if entry.track_type == "workshop":
            continue
        historical = historical_foundation_match(entry.title, entry.year, config)
        pool = (
            "historical_foundation"
            if historical
            else is_official_relevant(entry.title, entry.abstract)
        )
        if not pool:
            continue
        tier = next(
            (name for name, venues in config["venue_tiers"].items() if entry.venue in venues),
            "unranked",
        )
        records.append(
            DiscoveryRecord(
                title=entry.title,
                paper_url=entry.landing_url,
                code_url=None,
                venue=entry.venue,
                year=entry.year,
                venue_tier=tier,
                pool=pool,
                discovered_by=entry.source_id,
                discovery_section=f"official_scan:{entry.track}",
                source_label=f"{entry.venue} {entry.year}",
                publication_track=entry.track_type,
                doi=entry.doi,
            )
        )
    return records


def official_evidence(entry: OfficialEntry, similarity: float) -> dict[str, Any]:
    return {
        "source_id": entry.source_id,
        "record_id": entry.record_id,
        "authority": entry.authority,
        "title": entry.title,
        "landing_url": entry.landing_url,
        "pdf_url": entry.pdf_url,
        "track": entry.track,
        "title_similarity": round(similarity, 6),
        "snapshot_sha256": entry.snapshot_sha256,
    }


def verify_against_official(
    papers: list[dict[str, Any]],
    entries: list[OfficialEntry],
    snapshots: list[dict[str, Any]],
    config: dict[str, Any],
) -> None:
    grouped: dict[tuple[str, int], list[OfficialEntry]] = {}
    exact_titles: dict[tuple[str, int, str], list[OfficialEntry]] = {}
    dois: dict[str, OfficialEntry] = {}
    for entry in entries:
        grouped.setdefault((entry.venue, entry.year), []).append(entry)
        exact_titles.setdefault((entry.venue, entry.year, title_key(entry.title)), []).append(entry)
        if entry.doi:
            dois[entry.doi.casefold()] = entry
    for paper in papers:
        candidates = grouped.get((paper["venue"], paper["year"]), [])
        expected = title_key(paper["title"])
        best: OfficialEntry | None = None
        similarity = 0.0
        paper_doi = paper["identifiers"].get("doi")
        if paper_doi and paper_doi.casefold() in dois:
            best = dois[paper_doi.casefold()]
            similarity = SequenceMatcher(None, expected, title_key(best.title)).ratio()
        elif expected and exact_titles.get((paper["venue"], paper["year"], expected)):
            exact = exact_titles[(paper["venue"], paper["year"], expected)]
            best = min(exact, key=lambda entry: entry.track_type != "main")
            similarity = 1.0
        elif candidates and expected:
            # Exact normalized titles cover almost every match.  Restrict the
            # expensive fuzzy fallback to plausible transcription variants.
            shortlist = [
                entry
                for entry in candidates
                if abs(len(title_key(entry.title)) - len(expected)) <= max(8, len(expected) // 5)
                and (
                    title_key(entry.title)[:8] == expected[:8]
                    or title_key(entry.title)[-8:] == expected[-8:]
                )
            ]
            if shortlist:
                best = max(
                    shortlist,
                    key=lambda entry: SequenceMatcher(
                        None, expected, title_key(entry.title)
                    ).ratio(),
                )
                similarity = SequenceMatcher(None, expected, title_key(best.title)).ratio()
        if best is not None:
            if similarity >= float(config.get("official_match_threshold", 0.88)):
                paper["publication_verification"] = best.authority
                paper["publication_track"] = best.track_type
                paper["official_proceedings"] = official_evidence(best, similarity)
                if best.pdf_url and best.pdf_url not in paper["paper_urls"]:
                    paper["paper_urls"].append(best.pdf_url)
                if best.pdf_url:
                    paper["open_access"]["pdf_url"] = best.pdf_url
                if best.doi:
                    paper["identifiers"]["doi"] = best.doi

        override = config.get("official_paper_overrides", {}).get(paper["title"])
        if override and paper["official_proceedings"] is None:
            evidence = {
                "source_id": override["source_id"],
                "record_id": override.get("record_id", title_key(paper["title"])),
                "authority": override.get("authority", "official_proceedings"),
                "title": override.get("title", paper["title"]),
                "landing_url": override["landing_url"],
                "pdf_url": override.get("pdf_url"),
                "track": override.get("track", "Main proceedings"),
                "snapshot_sha256": override.get("snapshot_sha256"),
                "title_similarity": 1.0,
            }
            paper["publication_verification"] = evidence["authority"]
            paper["publication_track"] = override.get(
                "track_type", paper.get("publication_track", "main")
            )
            paper["official_proceedings"] = evidence
            if evidence.get("pdf_url") and evidence["pdf_url"] not in paper["paper_urls"]:
                paper["paper_urls"].append(evidence["pdf_url"])

    relevant_pairs = {
        (entry.source_id, entry.snapshot_sha256)
        for entry in entries
        if entry.track_type != "workshop" and is_official_relevant(entry.title, entry.abstract)
    }
    for snapshot in snapshots:
        pair = (snapshot["source_id"], snapshot.get("sha256"))
        snapshot["records_matched"] = sum(
            paper["official_proceedings"] is not None
            and paper["official_proceedings"]["source_id"] == snapshot["source_id"]
            and paper["official_proceedings"].get("snapshot_sha256") == snapshot.get("sha256")
            for paper in papers
        )
        snapshot["relevant_records_discovered"] = int(pair in relevant_pairs) and sum(
            entry.source_id == snapshot["source_id"]
            and entry.snapshot_sha256 == snapshot.get("sha256")
            and entry.track_type != "workshop"
            and is_official_relevant(entry.title, entry.abstract) is not None
            for entry in entries
        )


def openalex_abstract(inverted_index: dict[str, list[int]] | None) -> str | None:
    if not inverted_index:
        return None
    positions = [
        (position, word)
        for word, offsets in inverted_index.items()
        for position in offsets
    ]
    return " ".join(word for _, word in sorted(positions))


def is_citation_relevant(title: str, abstract: str | None) -> str | None:
    direct = is_official_relevant(title, abstract)
    if direct:
        return direct
    text = normalize_space(f"{title} {abstract or ''}").casefold()
    if "time series" not in text and "time-series" not in text:
        return None
    mechanism_terms = (
        "normalization",
        "non-stationarity",
        "nonstationarity",
        "distribution shift",
        "concept drift",
        "frequency domain",
        "decomposition",
        "foundation model",
        "state space",
        "state-space",
        "exogenous",
        "uncertainty",
        "calibration",
        "benchmark",
        "evaluation",
    )
    return "accepted_adjacent" if any(term in text for term in mechanism_terms) else None


def expand_openalex_citations(
    papers: list[dict[str, Any]],
    official_entries: list[OfficialEntry],
    config: dict[str, Any],
    cache_dir: Path,
    refresh: bool = False,
) -> tuple[list[DiscoveryRecord], dict[str, Any]]:
    citation_config = config.get("citation_expansion") or {}
    report: dict[str, Any] = {
        "schema_version": "openalex_citation_expansion_v1",
        "generated_at": utc_now(),
        "source_id": citation_config.get("source_id", "openalex_citation_expansion"),
        "status": "disabled",
        "seeds": [],
        "records_considered": 0,
        "records_relevant": 0,
        "records_added_to_discovery": 0,
    }
    if not citation_config.get("enabled", False):
        return [], report
    paper_by_title = {title_key(paper["title"]): paper for paper in papers}
    configured_seeds = []
    for seed_label, seed_title in citation_config.get("seeds", {}).items():
        seed_paper = paper_by_title.get(title_key(seed_title))
        configured_seeds.append(
            {
                "label": seed_label,
                "title": seed_title,
                "openalex_id": (
                    seed_paper.get("identifiers", {}).get("openalex")
                    if seed_paper
                    else None
                ),
                "status": "not_run",
                "records": 0,
                "sha256": None,
            }
        )
    report["seeds"] = configured_seeds
    api_key = os.environ.get("OPENALEX_API_KEY")
    if not api_key:
        report["status"] = "blocked_missing_api_key"
        report["error"] = (
            "Set OPENALEX_API_KEY to run one-hop citation expansion. "
            "No key is stored in policy or generated artifacts."
        )
        return [], report

    official_by_title = {
        (entry.year, title_key(entry.title)): entry for entry in official_entries
    }
    output: list[DiscoveryRecord] = []
    cache_dir.mkdir(parents=True, exist_ok=True)
    for seed_report in report["seeds"]:
        seed_label = seed_report["label"]
        seed_id = seed_report["openalex_id"]
        seed_report["status"] = "unresolved"
        if not seed_id:
            continue
        work_id = str(seed_id).rsplit("/", 1)[-1]
        params = {
            "filter": (
                f"cites:{work_id},from_publication_date:"
                f"{config['policy']['start_year']}-01-01"
            ),
            "per_page": int(citation_config.get("max_results_per_seed", 100)),
            "sort": "cited_by_count:desc",
            "select": (
                "id,doi,title,publication_year,abstract_inverted_index,"
                "best_oa_location,open_access,locations"
            ),
            "api_key": api_key,
        }
        url = "https://api.openalex.org/works?" + urllib.parse.urlencode(params)
        cache_path = cache_dir / f"citing-{work_id}.json"
        try:
            payload_text = cached_text(url, cache_path, refresh)
            payload = json.loads(payload_text)
        except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError) as error:
            seed_report["status"] = "failed"
            seed_report["error"] = str(error)[:1000]
            continue
        checksum = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
        results = payload.get("results", [])
        seed_report.update(status="scanned", records=len(results), sha256=checksum)
        report["records_considered"] += len(results)
        for candidate in results:
            title = normalize_space(str(candidate.get("title") or ""))
            year = candidate.get("publication_year")
            if not title or not isinstance(year, int) or year < config["policy"]["start_year"]:
                continue
            abstract = openalex_abstract(candidate.get("abstract_inverted_index"))
            pool = is_citation_relevant(title, abstract)
            official = official_by_title.get((year, title_key(title)))
            if official and official.track_type != "workshop" and pool:
                venue = official.venue
                tier = next(
                    (
                        name
                        for name, venues in config["venue_tiers"].items()
                        if venue in venues
                    ),
                    "unranked",
                )
                paper_url = official.landing_url
                track = official.track_type
            else:
                external = external_pool(title, title.split(":", 1)[0], config)
                if not external:
                    continue
                pool = external
                venue = "OpenAlex"
                tier = "unranked"
                paper_url = str(candidate.get("id") or "")
                track = "external"
            if not paper_url:
                continue
            doi = candidate.get("doi")
            if isinstance(doi, str):
                doi = doi.removeprefix("https://doi.org/")
            output.append(
                DiscoveryRecord(
                    title=title,
                    paper_url=paper_url,
                    code_url=None,
                    venue=venue,
                    year=year,
                    venue_tier=tier,
                    pool=pool,
                    discovered_by=report["source_id"],
                    discovery_section=f"one_hop_citing:{seed_label}",
                    source_label=f"OpenAlex cites {work_id}",
                    publication_track=track,
                    openalex=str(candidate.get("id")) if candidate.get("id") else None,
                    doi=doi,
                )
            )
            report["records_relevant"] += 1

    report["status"] = (
        "completed"
        if any(seed["status"] == "scanned" for seed in report["seeds"])
        else "failed"
    )
    report["records_added_to_discovery"] = len(output)
    return output, report


def download_pdf(paper: dict[str, Any], pdf_dir: Path, max_bytes: int) -> dict[str, Any]:
    destination = pdf_dir / f"{paper['paper_id']}.pdf"
    if destination.exists() and destination.stat().st_size > 4:
        with destination.open("rb") as handle:
            if handle.read(4) == b"%PDF":
                return {
                    "status": "downloaded",
                    "path": str(destination),
                    "source_url": paper["open_access"].get("pdf_url"),
                    "final_url": None,
                    "sha256": file_sha256(destination),
                    "bytes": destination.stat().st_size,
                    "error": None,
                }

    candidates = []
    if paper["open_access"].get("pdf_url"):
        candidates.append(paper["open_access"]["pdf_url"])
    candidates.extend(filter(None, (direct_pdf_url(url) for url in paper["paper_urls"])))
    candidates = list(dict.fromkeys(candidates))
    if not candidates:
        return {**paper["download"], "status": "no_public_pdf", "error": "No public PDF URL found."}

    errors: list[str] = []
    pdf_dir.mkdir(parents=True, exist_ok=True)
    for source_url in candidates:
        try:
            data, final_url, content_type = http_get(source_url, timeout=90)
            if len(data) > max_bytes:
                raise ValueError(f"PDF exceeds max_bytes={max_bytes}")
            if not data.startswith(b"%PDF"):
                raise ValueError(f"Response is not a PDF (content-type={content_type!r})")
            destination.write_bytes(data)
            return {
                "status": "downloaded",
                "path": str(destination),
                "source_url": source_url,
                "final_url": final_url,
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
                "error": None,
            }
        except (OSError, ValueError, urllib.error.URLError) as error:
            errors.append(f"{source_url}: {error}")
    return {**paper["download"], "status": "failed", "error": " | ".join(errors)[:2000]}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_jsonl(path: Path, records: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    temp.replace(path)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temp.replace(path)


def load_previous_catalog(output_root: Path) -> list[dict[str, Any]]:
    path = output_root / "catalog" / "papers.jsonl"
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            records.append(json.loads(line))
    return records


def reuse_stable_ids(
    papers: list[dict[str, Any]], previous: list[dict[str, Any]]
) -> None:
    by_title = {title_key(item["title"]): item["paper_id"] for item in previous}
    for paper in papers:
        previous_id = by_title.get(title_key(paper["title"]))
        if previous_id:
            paper["paper_id"] = previous_id
            continue
        candidates = [
            item
            for item in previous
            if item["year"] == paper["year"] and item["venue"] == paper["venue"]
        ]
        if not candidates:
            continue
        best = max(
            candidates,
            key=lambda item: SequenceMatcher(
                None, title_key(paper["title"]), title_key(item["title"])
            ).ratio(),
        )
        if SequenceMatcher(
            None, title_key(paper["title"]), title_key(best["title"])
        ).ratio() >= 0.97:
            paper["paper_id"] = best["paper_id"]


def carry_forward_metadata(
    papers: list[dict[str, Any]], previous: list[dict[str, Any]]
) -> None:
    previous_by_id = {item["paper_id"]: item for item in previous}
    for paper in papers:
        old = previous_by_id.get(paper["paper_id"])
        if not old:
            continue
        for identifier in ("openalex", "doi", "arxiv"):
            if not paper["identifiers"].get(identifier):
                paper["identifiers"][identifier] = old.get("identifiers", {}).get(identifier)
        for field in ("is_oa", "oa_status", "pdf_url"):
            if paper["open_access"].get(field) is None:
                paper["open_access"][field] = old.get("open_access", {}).get(field)
        old_download = old.get("download") or {}
        old_path = old_download.get("path")
        if old_download.get("status") == "downloaded" and old_path:
            paper["download"] = old_download
        elif old_download.get("status") in {"failed", "no_public_pdf"}:
            paper["download"] = old_download


def recover_local_download_state(papers: list[dict[str, Any]], output_root: Path) -> None:
    """Recover generated PDF state even when a prior catalog entry was absent."""
    for paper in papers:
        destination = output_root / "pdfs" / f"{paper['paper_id']}.pdf"
        if paper["download"]["status"] != "downloaded" and destination.exists():
            with destination.open("rb") as handle:
                is_pdf = handle.read(4) == b"%PDF"
            if is_pdf:
                paper["download"] = {
                    "status": "downloaded",
                    "path": str(destination),
                    "source_url": paper["open_access"].get("pdf_url"),
                    "final_url": None,
                    "sha256": file_sha256(destination),
                    "bytes": destination.stat().st_size,
                    "error": None,
                }
                continue
        candidates = [paper["open_access"].get("pdf_url")]
        candidates.extend(direct_pdf_url(url) for url in paper["paper_urls"])
        if paper["download"]["status"] == "not_attempted" and not any(candidates):
            paper["download"] = {
                **paper["download"],
                "status": "no_public_pdf",
                "error": "No public PDF URL found.",
            }


def record_fingerprint(record: dict[str, Any]) -> str:
    stable = {
        key: value
        for key, value in record.items()
        if key not in {"download", "openalex_error"}
    }
    return hashlib.sha256(
        json.dumps(stable, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def build_coverage(
    papers: list[dict[str, Any]],
    previous: list[dict[str, Any]],
    snapshots: list[dict[str, Any]],
    config: dict[str, Any],
    citation_report: dict[str, Any] | None = None,
) -> dict[str, Any]:
    official_statuses = {"official_proceedings"}
    authority_statuses = {"official_proceedings", "publisher_metadata"}
    target_years = config.get("coverage_targets", {}).get(
        "years", list(range(config["policy"]["start_year"], max([p["year"] for p in papers] or [2026]) + 1))
    )
    configured_venues = config.get("coverage_targets", {}).get("venues", [])
    target_venues = sorted(
        set(configured_venues)
        | {paper["venue"] for paper in papers if paper["venue_tier"] in {"A", "B"}}
    )
    matrix: dict[str, dict[str, Any]] = {}
    for venue in target_venues:
        for year in target_years:
            candidates = [paper for paper in papers if paper["venue"] == venue and paper["year"] == year]
            relevant_snapshots = [
                item for item in snapshots if item.get("venue") == venue and item.get("year") == year
            ]
            scanned = [item for item in relevant_snapshots if item.get("status") == "scanned"]
            official_count = sum(
                paper["publication_verification"] in official_statuses for paper in candidates
            )
            publisher_count = sum(
                paper["publication_verification"] == "publisher_metadata" for paper in candidates
            )
            authority_count = official_count + publisher_count
            matrix[f"{venue}:{year}"] = {
                "venue": venue,
                "year": year,
                "candidate_count": len(candidates),
                "directory_status": (
                    "scanned"
                    if scanned
                    else "failed"
                    if relevant_snapshots
                    else "not_configured"
                ),
                "directory_records": sum(item.get("records_in_index", 0) for item in scanned),
                "official_proceedings_verified": official_count,
                "publisher_metadata_verified": publisher_count,
                "authority_verified": authority_count,
                "curated_venue_claims": sum(
                    paper["publication_verification"] == "curated_venue_claim"
                    for paper in candidates
                ),
                "authority_verification_rate": (
                    round(authority_count / len(candidates), 6) if candidates else None
                ),
                "unmatched_candidates": [
                    paper["paper_id"]
                    for paper in candidates
                    if paper["publication_verification"] == "curated_venue_claim"
                ],
                "snapshot_sources": sorted({item["source_id"] for item in relevant_snapshots}),
            }

    total = len(papers)
    primary_papers = [paper for paper in papers if paper["pool"] != "historical_foundation"]
    historical_papers = [paper for paper in papers if paper["pool"] == "historical_foundation"]
    official_count = sum(paper["publication_verification"] in official_statuses for paper in papers)
    authority_count = sum(paper["publication_verification"] in authority_statuses for paper in papers)
    source_ids = [source["id"] for source in config["discovery_sources"]]
    historical_source_id = (config.get("historical_foundations") or {}).get("source_id")
    if historical_source_id:
        source_ids.append(historical_source_id)
    citation_source_id = (config.get("citation_expansion") or {}).get("source_id")
    if citation_source_id:
        source_ids.append(citation_source_id)
    source_papers: dict[str, set[str]] = {
        source_id: {
            paper["paper_id"]
            for paper in papers
            if any(item["source_id"] == source_id for item in paper["discovery_sources"])
        }
        for source_id in source_ids
    }
    source_contributions = {}
    for source_id, paper_ids in source_papers.items():
        source_contributions[source_id] = {
            "papers": len(paper_ids),
            "unique": sum(
                paper_id not in set().union(
                    *(ids for other, ids in source_papers.items() if other != source_id)
                )
                for paper_id in paper_ids
            ),
        }
    overlaps = []
    for left_index, left in enumerate(source_ids):
        for right in source_ids[left_index + 1 :]:
            count = len(source_papers[left] & source_papers[right])
            if count:
                overlaps.append({"left": left, "right": right, "papers": count})

    current_by_id = {item["paper_id"]: item for item in papers}
    previous_by_id = {item["paper_id"]: item for item in previous}
    added = sorted(current_by_id.keys() - previous_by_id.keys())
    removed = sorted(previous_by_id.keys() - current_by_id.keys())
    changed = sorted(
        paper_id
        for paper_id in current_by_id.keys() & previous_by_id.keys()
        if record_fingerprint(current_by_id[paper_id]) != record_fingerprint(previous_by_id[paper_id])
    )
    identifier_counts = {
        name: sum(bool(paper["identifiers"].get(name)) for paper in papers)
        for name in ("doi", "openalex", "arxiv")
    }
    identifier_counts["code"] = sum(bool(paper["code_urls"]) for paper in papers)
    known_gaps = [
        {
            "source_id": item["source_id"],
            "venue": item.get("venue"),
            "year": item.get("year"),
            "status": item.get("status"),
            "error": item.get("error"),
        }
        for item in snapshots
        if item.get("status") != "scanned"
    ]
    known_gaps.extend(
        {
            "source_id": None,
            "venue": item["venue"],
            "year": item["year"],
            "status": "not_configured",
            "error": "No official or publisher-metadata directory adapter is configured.",
        }
        for item in matrix.values()
        if item["directory_status"] == "not_configured"
    )
    if citation_report and citation_report.get("status") not in {"completed", "disabled"}:
        known_gaps.append(
            {
                "source_id": citation_report.get("source_id"),
                "venue": None,
                "year": None,
                "status": citation_report.get("status"),
                "error": citation_report.get("error", "Citation expansion did not complete."),
            }
        )
    manual_review = [
        {
            "paper_id": paper["paper_id"],
            "title": paper["title"],
            "venue": paper["venue"],
            "year": paper["year"],
            "reason": (
                "curated venue claim unmatched to configured authority"
                if paper["publication_verification"] == "curated_venue_claim"
                else f"non-main publication track: {paper['publication_track']}"
            ),
        }
        for paper in papers
        if paper["publication_verification"] == "curated_venue_claim"
        or paper["publication_track"] not in {"main", "external", "preprint"}
    ]
    return {
        "schema_version": "literature_coverage_v1",
        "generated_at": utc_now(),
        "source_id": config["source_id"],
        "summary": {
            "papers": total,
            "official_proceedings_verified": official_count,
            "official_proceedings_rate": round(official_count / total, 6) if total else 0.0,
            "authority_verified": authority_count,
            "authority_verification_rate": round(authority_count / total, 6) if total else 0.0,
            "curated_venue_claims": sum(
                paper["publication_verification"] == "curated_venue_claim" for paper in papers
            ),
        },
        "primary_scope": scope_summary(primary_papers),
        "historical_foundations": {
            **scope_summary(historical_papers),
            "year_range": (
                [
                    min(paper["year"] for paper in historical_papers),
                    max(paper["year"] for paper in historical_papers),
                ]
                if historical_papers
                else None
            ),
            "records": [
                {
                    "paper_id": paper["paper_id"],
                    "title": paper["title"],
                    "year": paper["year"],
                    "venue": paper["venue"],
                    "publication_verification": paper["publication_verification"],
                    "download_status": paper["download"]["status"],
                }
                for paper in sorted(
                    historical_papers,
                    key=lambda item: (item["year"], item["title"].casefold()),
                )
            ],
        },
        "by_venue_year": matrix,
        "by_pool": {
            pool: sum(paper["pool"] == pool for paper in papers)
            for pool in (
                "historical_foundation",
                "accepted_core",
                "accepted_adjacent",
                "influential_external",
                "watchlist",
            )
        },
        "by_publication_track": {
            track: sum(paper["publication_track"] == track for paper in papers)
            for track in ("main", "special", "journal", "workshop", "preprint", "external", "unknown")
        },
        "by_download_status": {
            status: sum(paper["download"]["status"] == status for paper in papers)
            for status in sorted({paper["download"]["status"] for paper in papers})
        },
        "identifier_coverage": {
            name: {
                "count": count,
                "rate": round(count / total, 6) if total else 0.0,
            }
            for name, count in identifier_counts.items()
        },
        "discovery_sources": source_contributions,
        "discovery_source_overlaps": overlaps,
        "changes": {"added": added, "removed": removed, "changed": changed},
        "known_gaps": known_gaps,
        "manual_review": manual_review,
    }


def scope_summary(papers: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(papers)
    official = sum(
        paper["publication_verification"] == "official_proceedings" for paper in papers
    )
    authority = sum(
        paper["publication_verification"] in {"official_proceedings", "publisher_metadata"}
        for paper in papers
    )
    return {
        "papers": total,
        "official_proceedings_verified": official,
        "official_proceedings_rate": round(official / total, 6) if total else 0.0,
        "authority_verified": authority,
        "authority_verification_rate": round(authority / total, 6) if total else 0.0,
    }


def coverage_markdown(coverage: dict[str, Any]) -> str:
    summary = coverage["summary"]
    primary = coverage["primary_scope"]
    historical = coverage["historical_foundations"]
    lines = [
        "# Literature Source Coverage",
        "",
        f"Generated: `{coverage['generated_at']}`",
        "",
        "## Summary",
        "",
        "| Metric | Value |",
        "|---|---:|",
        f"| Papers | {summary['papers']} |",
        f"| Official proceedings verified | {summary['official_proceedings_verified']} ({summary['official_proceedings_rate']:.1%}) |",
        f"| Authority verified (official + publisher metadata) | {summary['authority_verified']} ({summary['authority_verification_rate']:.1%}) |",
        f"| Curated venue claims | {summary['curated_venue_claims']} |",
        f"| Primary scope papers (2023+) | {primary['papers']} |",
        f"| Primary authority verified | {primary['authority_verified']} ({primary['authority_verification_rate']:.1%}) |",
        f"| Historical foundations | {historical['papers']} |",
        f"| Historical authority verified | {historical['authority_verified']} ({historical['authority_verification_rate']:.1%}) |",
        "",
        "## Venue/year matrix",
        "",
        "| Venue | Year | Directory | Candidates | Official | Publisher metadata | Authority rate | Unmatched |",
        "|---|---:|---|---:|---:|---:|---:|---:|",
    ]
    for item in coverage["by_venue_year"].values():
        rate = item["authority_verification_rate"]
        lines.append(
            f"| {item['venue']} | {item['year']} | {item['directory_status']} | "
            f"{item['candidate_count']} | {item['official_proceedings_verified']} | "
            f"{item['publisher_metadata_verified']} | "
            f"{rate:.1%} | {len(item['unmatched_candidates'])} |"
            if rate is not None
            else f"| {item['venue']} | {item['year']} | {item['directory_status']} | 0 | 0 | 0 | — | 0 |"
        )
    lines.extend(["", "## Discovery source contribution", "", "| Source | Papers | Unique |", "|---|---:|---:|"])
    for source_id, counts in coverage["discovery_sources"].items():
        lines.append(f"| `{source_id}` | {counts['papers']} | {counts['unique']} |")
    lines.extend(
        [
            "",
            "## Historical foundations",
            "",
            "| Year | Venue | Paper | Verification | PDF |",
            "|---:|---|---|---|---|",
        ]
    )
    for item in historical["records"]:
        lines.append(
            f"| {item['year']} | {item['venue']} | {item['title']} | "
            f"{item['publication_verification']} | {item['download_status']} |"
        )
    changes = coverage["changes"]
    lines.extend(
        [
            "",
            "## Incremental changes",
            "",
            f"- Added: {len(changes['added'])}",
            f"- Removed: {len(changes['removed'])}",
            f"- Changed: {len(changes['changed'])}",
            "",
            "## Known gaps and manual review",
            "",
            f"- Directory scan gaps: {len(coverage['known_gaps'])}",
            f"- Records requiring review: {len(coverage['manual_review'])}",
            "",
            "See `coverage.json` for IDs, source overlaps, identifier/PDF coverage, and detailed failure records.",
            "",
        ]
    )
    return "\n".join(lines)


def load_config(path: Path) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    historical = config.get("historical_foundations") or {}
    manifest_path = historical.get("manifest_path")
    if manifest_path:
        resolved = (path.parent / manifest_path).resolve()
        manifest_bytes = resolved.read_bytes()
        manifest = json.loads(manifest_bytes)
        historical["records"] = manifest["records"]
        historical["manifest_sha256"] = hashlib.sha256(manifest_bytes).hexdigest()
        historical["manifest_path_resolved"] = str(resolved)
    return config


def build_source(args: argparse.Namespace) -> int:
    config_path = Path(args.config).resolve()
    config = load_config(config_path)
    output_root = Path(args.output_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    previous_papers = load_previous_catalog(output_root)
    all_discovered: list[DiscoveryRecord] = []
    source_snapshots: list[dict[str, Any]] = []

    historical_records = historical_discovery_records(config)
    if historical_records:
        historical = config["historical_foundations"]
        all_discovered.extend(historical_records)
        source_snapshots.append(
            {
                "source_id": historical["source_id"],
                "snapshot_url": historical.get("manifest_path_resolved"),
                "revision": historical.get("version"),
                "sha256": historical.get("manifest_sha256"),
                "records_discovered": len(historical_records),
            }
        )
        print(
            f"discovery source={historical['source_id']} records={len(historical_records)}",
            flush=True,
        )

    for index, source in enumerate(config["discovery_sources"]):
        override = args.source_readme if index == 0 and args.source_readme else None
        markdown = load_text(
            source,
            override,
            output_root / "cache" / "discovery",
            refresh=args.refresh_discovery,
        )
        checksum = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
        parser_name = source["parser"]
        if parser_name == "tscenter_markdown_tables":
            discovered = parse_tsc_table_source(markdown, source, config)
        elif parser_name == "forecast_bullets":
            discovered = parse_bullet_source(markdown, source, config)
        elif parser_name == "tongji_paper_bullets":
            discovered = parse_tongji_source(markdown, source, config)
        elif parser_name == "thuml_model_inventory":
            discovered = parse_thuml_source(markdown, source, config)
        else:
            raise ValueError(f"Unsupported discovery parser: {parser_name}")
        all_discovered.extend(discovered)
        source_snapshots.append(
            {
                "source_id": source["id"],
                "snapshot_url": source["snapshot_url"],
                "revision": source.get("revision"),
                "sha256": checksum,
                "records_discovered": len(discovered),
            }
        )
        print(f"discovery source={source['id']} records={len(discovered)}", flush=True)

    if args.skip_official:
        official_entries: list[OfficialEntry] = []
        proceedings_snapshots: list[dict[str, Any]] = []
    else:
        official_entries, proceedings_snapshots = scan_official_sources(
            config,
            output_root / "cache" / "proceedings",
            refresh=args.refresh_official,
        )
        official_records = official_discovery_records(official_entries, config)
        all_discovered.extend(official_records)
        print(f"official discovery records={len(official_records)}", flush=True)

    filtered = apply_policy(all_discovered, config)
    papers = deduplicate(filtered)
    reuse_stable_ids(papers, previous_papers)
    verify_against_official(papers, official_entries, proceedings_snapshots, config)
    carry_forward_metadata(papers, previous_papers)
    recover_local_download_state(papers, output_root)
    print(f"catalog discovered={len(all_discovered)} filtered={len(filtered)} deduplicated={len(papers)}", flush=True)

    cache_dir = output_root / "cache" / "openalex"
    if not args.skip_openalex:
        for index, paper in enumerate(papers, start=1):
            try:
                enrich_openalex(paper, cache_dir)
            except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError) as error:
                paper["openalex_error"] = str(error)
            if index % 20 == 0 or index == len(papers):
                print(f"openalex enriched={index}/{len(papers)}", flush=True)
            if args.openalex_delay > 0:
                time.sleep(args.openalex_delay)

    if args.skip_citations:
        citation_report = {
            "schema_version": "openalex_citation_expansion_v1",
            "generated_at": utc_now(),
            "source_id": (config.get("citation_expansion") or {}).get(
                "source_id", "openalex_citation_expansion"
            ),
            "status": "disabled",
            "seeds": [],
            "records_considered": 0,
            "records_relevant": 0,
            "records_added_to_discovery": 0,
        }
        citation_records: list[DiscoveryRecord] = []
    else:
        citation_records, citation_report = expand_openalex_citations(
            papers,
            official_entries,
            config,
            output_root / "cache" / "openalex-citations",
            refresh=args.refresh_citations,
        )
    if citation_records:
        enriched_before_expansion = papers
        all_discovered.extend(citation_records)
        filtered = apply_policy(all_discovered, config)
        papers = deduplicate(filtered)
        reuse_stable_ids(papers, previous_papers)
        verify_against_official(papers, official_entries, proceedings_snapshots, config)
        carry_forward_metadata(papers, enriched_before_expansion)
        carry_forward_metadata(papers, previous_papers)
        recover_local_download_state(papers, output_root)
        print(
            f"citation expansion records={len(citation_records)} "
            f"catalog deduplicated={len(papers)}",
            flush=True,
        )
    write_json(output_root / "citation_expansion.json", citation_report)

    download_limit = args.max_downloads if args.max_downloads is not None else len(papers)
    if not args.skip_download and download_limit > 0:
        targets = papers[:download_limit]
        pdf_dir = output_root / "pdfs"
        max_bytes = int(config["download"]["max_pdf_bytes"])
        workers = int(config["download"]["workers"])
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(download_pdf, paper, pdf_dir, max_bytes): paper for paper in targets}
            completed = 0
            for future in concurrent.futures.as_completed(futures):
                paper = futures[future]
                try:
                    paper["download"] = future.result()
                except Exception as error:  # keep the rest of the catalog usable
                    paper["download"] = {**paper["download"], "status": "failed", "error": repr(error)}
                completed += 1
                if completed % 10 == 0 or completed == len(targets):
                    downloaded = sum(item["download"]["status"] == "downloaded" for item in targets)
                    print(f"download completed={completed}/{len(targets)} succeeded={downloaded}", flush=True)

    for paper in papers:
        if paper["download"]["path"]:
            try:
                paper["download"]["path"] = str(Path(paper["download"]["path"]).relative_to(output_root))
            except ValueError:
                pass

    write_jsonl(output_root / "catalog" / "papers.jsonl", papers)
    retry_records = [
        {
            "paper_id": paper["paper_id"],
            "title": paper["title"],
            "status": paper["download"]["status"],
            "candidate_urls": list(
                dict.fromkeys(
                    filter(
                        None,
                        [paper["open_access"].get("pdf_url")]
                        + [direct_pdf_url(url) for url in paper["paper_urls"]],
                    )
                )
            ),
            "error": paper["download"].get("error"),
        }
        for paper in papers
        if paper["download"]["status"] in {"failed", "no_public_pdf"}
    ]
    write_jsonl(output_root / "retry_queue.jsonl", retry_records)
    coverage = build_coverage(
        papers, previous_papers, proceedings_snapshots, config, citation_report
    )
    write_json(output_root / "coverage.json", coverage)
    (output_root / "COVERAGE.md").write_text(coverage_markdown(coverage), encoding="utf-8")

    counts_by_pool = {
        pool: sum(item["pool"] == pool for item in papers)
        for pool in (
            "historical_foundation",
            "accepted_core",
            "accepted_adjacent",
            "influential_external",
            "watchlist",
        )
    }
    counts_by_year = {str(year): sum(item["year"] == year for item in papers) for year in sorted({p["year"] for p in papers})}
    counts_by_status = {
        status: sum(item["download"]["status"] == status for item in papers)
        for status in sorted({p["download"]["status"] for p in papers})
    }
    manifest = {
        "schema_version": "literature_source_manifest_v2",
        "source_id": config["source_id"],
        "built_at": utc_now(),
        "config_path": str(config_path),
        "policy": config["policy"],
        "source_snapshots": source_snapshots,
        "proceedings_snapshots": proceedings_snapshots,
        "audit_sources": config.get("audit_sources", []),
        "counts": {
            "papers": len(papers),
            "by_pool": counts_by_pool,
            "by_year": counts_by_year,
            "by_download_status": counts_by_status,
        },
        "catalog_path": "catalog/papers.jsonl",
        "coverage_path": "coverage.json",
        "coverage_markdown_path": "COVERAGE.md",
        "retry_queue_path": "retry_queue.jsonl",
        "citation_expansion_path": "citation_expansion.json",
        "pdf_root": "pdfs",
    }
    write_json(output_root / "source_manifest.json", manifest)
    print(json.dumps(manifest["counts"], ensure_ascii=False, sort_keys=True), flush=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    default_config = Path(__file__).resolve().parents[1] / "literature_source" / "source_policy.json"
    default_output = Path(__file__).resolve().parents[1] / ".neo-cast" / "literature-source"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(default_config))
    parser.add_argument("--output-root", default=str(default_output))
    parser.add_argument("--source-readme", help="Use a local README for the first discovery source.")
    parser.add_argument("--skip-openalex", action="store_true")
    parser.add_argument("--skip-citations", action="store_true")
    parser.add_argument("--refresh-citations", action="store_true")
    parser.add_argument("--skip-official", action="store_true")
    parser.add_argument("--refresh-official", action="store_true")
    parser.add_argument("--refresh-discovery", action="store_true")
    parser.add_argument("--skip-download", action="store_true")
    parser.add_argument("--max-downloads", type=int)
    parser.add_argument("--openalex-delay", type=float, default=0.03)
    return parser


def main(argv: list[str] | None = None) -> int:
    return build_source(build_parser().parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
