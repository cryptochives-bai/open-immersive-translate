/**
 * In-process channel between the page controller and content features.
 *
 * These signals used to travel as CustomEvents on `document`, which page
 * scripts can both dispatch and observe. This EventTarget lives only in the
 * content script's isolated world.
 */
export const featureBus = new EventTarget();

/** Controller -> selection panel: show a translation for `detail.text`. Cancelable. */
export const TRANSLATE_SELECTION_EVENT = "translate-selection";
/** Controller -> subtitles: toggle video subtitle pre-translation. */
export const SUBTITLE_PRETRANSLATION_EVENT = "video-subtitle-pretranslation";
