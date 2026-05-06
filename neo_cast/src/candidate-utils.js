"use strict";

function describeCandidateId(payload) {
  return payload.candidate_id || payload.recipe_id || payload.model_name || "NA";
}

function describeCandidateFamily(payload) {
  if (payload.model_family) return payload.model_family;
  if (payload.schema_version === "model_recipe.v1") {
    const backbone = payload.architecture?.backbone || "unknown_backbone";
    const multiscale = Number(payload.architecture?.multiscale_blocks || 0) > 1 ? "+multiscale" : "";
    return `model_recipe:${backbone}${multiscale}`;
  }
  if (payload.recipe_version === "recipe_schema_v1") {
    const embedding = payload.embedding?.type || "unknown_embedding";
    const backbone = payload.backbone?.type || "unknown_backbone";
    return `recipe:${embedding}+${backbone}`;
  }
  return "unknown";
}

module.exports = {
  describeCandidateFamily,
  describeCandidateId,
};
