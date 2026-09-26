"use strict";

function describeCandidateId(payload) {
  return payload.candidate_id || payload.recipe_id || payload.model_name || "NA";
}

function describeCandidateFamily(payload) {
  if (payload.model_family) return payload.model_family;
  if (["model_recipe.v1", "model_recipe.v2"].includes(payload.schema_version)) {
    const backbone = payload.architecture?.backbone?.type || payload.architecture?.backbone || "unknown_backbone";
    const multiscale = Number(payload.architecture?.multiscale_blocks || 0) > 1 ? "+multiscale" : "";
    return `model_recipe:${backbone}${multiscale}`;
  }
  if (["recipe_schema_v2", "recipe_schema_v3"].includes(payload.recipe_version)) {
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
