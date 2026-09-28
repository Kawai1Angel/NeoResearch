import type { IndexedPaper } from "./local-index-builder"

export const MODEL_RECIPE_SCREEN_VERSION = "model_recipe_mechanism_screen_v5"

// Match only distinctive mechanisms that the current ModelRecipe schema and runtime
// cannot express. A generic Transformer, patch, frequency, or mixer mention is not
// evidence that the paper's core operation is executable (or inapplicable).
const unsupported = [
  { id: "exogenous_cross_attention", field: "fusion", pattern: /\bTimeXer\b|\bexogenous\b.{0,50}\bcross[- ]attention\b/i },
  { id: "koopman_dynamics", field: "backbone", pattern: /\bKoopman\b/i },
  { id: "wavelet_decomposition", field: "embedding", pattern: /\bwavelet\b|\bWPMixer\b/i },
  { id: "capsule_compression_attention", field: "backbone", pattern: /\bTimeCapsule\b|\bcapsule\b.{0,40}\bcompress(?:ion|ed)\b/i },
  { id: "lagged_correlation_attention", field: "fusion", pattern: /\bVCformer\b|\b(?:lagged|lag[- ]aware)\b.{0,40}\b(?:correlation|attention)\b/i },
  { id: "diffusion_generation", field: "backbone", pattern: /\bdiffusion(?:[- ]based)?\s+(?:model|generation|forecasting)\b|\b(?:denoising|score[- ]based)\s+diffusion\b/i },
  { id: "auto_correlation_attention", field: "backbone", pattern: /\bAutoformer\b|\bauto[- ]correlation\b/i },
  { id: "frequency_domain_attention", field: "backbone", pattern: /\bFEDformer\b|\bFourier\b.{0,40}\battention\b/i },
  { id: "frequency_alignment_bypass", field: "embedding", pattern: /\bFremer\b|\bfrequency\b.{0,40}\balignment\b.{0,40}\bbypass\b/i },
  { id: "causal_state_discovery", field: "backbone", pattern: /\bSPACETIME\b|\bcausal\b.{0,40}\bstate\b.{0,40}\bdiscover/i },
  { id: "sigmoid_learning_rate_schedule", field: "scheduler", pattern: /\bxPatch\b|\bsigmoid\b.{0,30}\blearning[- ]rate\b/i },
  { id: "adaptive_leading_indicator_plugin", field: "fusion", pattern: /^Rethinking Channel Dependence for Multivariate Time Series Forecasting: Learning from Leading Indicators$/i, titleOnly: true },
  { id: "regime_switching_posterior_factor", field: "backbone", pattern: /^RSAP-DFM:/i, titleOnly: true },
  { id: "variable_time_hyperstate", field: "backbone", pattern: /^TimePro:/i, titleOnly: true },
  { id: "cross_future_behavior", field: "fusion", pattern: /^CRAFT: Time Series Forecasting with Cross-Future Behavior Awareness$/i, titleOnly: true },
  { id: "seasonal_trend_masked_pretraining", field: "loss", pattern: /^ST-MTM:/i, titleOnly: true },
  { id: "spatiotemporal_flow_trend", field: "fusion", pattern: /^iTrendRNN:/i, titleOnly: true },
  { id: "instance_aware_posthoc_revision", field: "head", pattern: /^Improving Time Series Forecasting via Instance-aware Post-hoc Revision$/i, titleOnly: true },
  { id: "text_forecast_modal_alignment", field: "embedding", pattern: /^From Text to Forecasts: Bridging Modality Gap with Temporal Evolution Semantic Space$/i, titleOnly: true },
  { id: "contextual_motif_retrieval", field: "backbone", pattern: /^CometNet:/i, titleOnly: true },
  { id: "autoregressive_recurrent_decoder", field: "head", pattern: /^DeepAR:/i, titleOnly: true },
  { id: "full_probabilistic_state_space", field: "backbone", pattern: /^Deep State Space Models\b/i, titleOnly: true },
  { id: "diffusion_graph_convolution", field: "fusion", pattern: /^Diffusion Convolutional Recurrent Neural Network\b/i, titleOnly: true },
  { id: "spatiotemporal_graph_convolution", field: "fusion", pattern: /^Spatio-Temporal Graph Convolutional Networks\b/i, titleOnly: true },
  { id: "learned_directed_graph", field: "fusion", pattern: /^Connecting the Dots: Multivariate Time Series Forecasting with Graph Neural Networks$/i, titleOnly: true },
  { id: "variable_selection_network", field: "fusion", pattern: /^Temporal Fusion Transformers\b/i, titleOnly: true },
  { id: "probsparse_attention", field: "backbone", pattern: /^Informer:/i, titleOnly: true },
  { id: "sample_convolution_interaction", field: "backbone", pattern: /^SCINet:/i, titleOnly: true },
  { id: "de_stationary_attention", field: "backbone", pattern: /^Non-stationary Transformers:/i, titleOnly: true },
  { id: "hierarchical_interpolation", field: "head", pattern: /^NHITS:/i, titleOnly: true },
  { id: "cross_dimension_two_stage_attention", field: "fusion", pattern: /^Crossformer:/i, titleOnly: true },
  { id: "multi_scale_isometric_convolution", field: "backbone", pattern: /^MICN:/i, titleOnly: true },
  { id: "past_future_multiscale_mixing", field: "backbone", pattern: /^TimeMixer:/i, titleOnly: true },
  { id: "sparse_cross_period_linear", field: "backbone", pattern: /^SparseTSF:/i, titleOnly: true },
  { id: "series_core_fusion", field: "fusion", pattern: /^SOFTS:/i, titleOnly: true },
] as const

export function unsupportedModelRecipeMechanisms(paper: Pick<IndexedPaper, "title" | "fields">) {
  // The title is an author claim about the central method. For other text require
  // an explicit self-description, so citations to earlier work do not filter a paper.
  const ownedMethod = `${paper.fields.abstract}\n${paper.fields.introduction}\n${paper.fields.method}`
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => /\b(?:we|our|this paper|this work)\b.{0,100}\b(?:propos|introduc|develop|model|method|framework|architectur|design|utiliz|employ|us(?:e|ing))\w*/i.test(sentence))
    .join("\n")
  return unsupported.filter((item) => item.pattern.test(paper.title) ||
    (!("titleOnly" in item) && item.pattern.test(ownedMethod)))
    .map((item) => ({ mechanism: item.id, missingAction: item.field }))
}
