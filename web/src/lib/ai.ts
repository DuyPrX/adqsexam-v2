import { getAiModelName, getAiProvider } from './env';

/**
 * AI model configuration for the teacher web's extraction UI.
 *
 * The MODEL IDS offered in the dropdown are deployment configuration, not
 * business logic: a district that has negotiated access to a different model
 * should be able to change it by editing an environment variable, not by
 * shipping a new build. `AI_MODEL_NAME` supplies the default the picker starts
 * on and the deployment's provider selects which shortlist is offered.
 *
 * The preset ids below stay in code on purpose: they are a curated shortlist of
 * models this build's provider is known to serve, and a malformed env value must
 * not be able to break the picker or offer an uncallable model. The free-text
 * option still covers anything outside the shortlist.
 */

/** Provider id the preset shortlist belongs to. */
const PRESET_PROVIDER = 'gemini';

/** Curated shortlist, offered only for the provider it was written for. */
const PRESET_MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  { value: 'gemma-4-31b-it', label: 'Gemma 4 (31B IT)' },
];

/** Sentinel that swaps the dropdown for a free-text model id input. */
export const CUSTOM_MODEL = '__custom__';

export interface ModelOption {
  /** Model id sent to the Worker; `''` means "let the Worker decide". */
  value: string;
  label: string;
}

/**
 * Builds the model dropdown from the deployment's configuration.
 *
 * The "default" option is always present and carries an EMPTY value: selecting
 * it means "no override", so the Worker's own `AI_MODEL_NAME` binding decides.
 * That keeps the Worker authoritative for its own deployment — one edit there
 * retargets every caller — while the label still tells the teacher which model
 * the default currently resolves to.
 */
export function buildModelOptions(): ModelOption[] {
  const defaultModel = getAiModelName();
  const options: ModelOption[] = [
    {
      value: '',
      label: defaultModel ? `Mặc định hệ thống (${defaultModel})` : 'Mặc định hệ thống',
    },
  ];
  if (getAiProvider() === PRESET_PROVIDER) options.push(...PRESET_MODELS);
  return options;
}
