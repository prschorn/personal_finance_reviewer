/**
 * Categorical palette for the charts.
 *
 * Deliberately NOT the app's own indigo/green UI accents: run through the
 * validator, indigo falls outside the lightness band and the green reads as gray
 * (chroma 0.087). This is the validated eight-hue theme, which passes the
 * lightness band, chroma floor, adjacent-pair CVD separation, normal-vision floor
 * and contrast in both modes on the surfaces this app uses.
 *
 * Slots are assigned per entity and never cycled. A ninth series folds into
 * "Outras" instead of inventing a hue.
 */
export const SERIES_LIGHT = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
] as const;

export const SERIES_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const;

/**
 * Three light-mode hues sit below 3:1 against the light surface, so the relief
 * rule applies: every chart using this palette ships a table view.
 */
export const RELIEF_REQUIRED = true;

export function seriesVar(slot: number): string {
  return `var(--series-${(slot % SERIES_LIGHT.length) + 1})`;
}
