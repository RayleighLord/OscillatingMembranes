import katex from "katex";

export function renderMath(element: HTMLElement, tex: string): void {
  katex.render(tex, element, {
    displayMode: false,
    throwOnError: false,
    strict: false,
    trust: false,
    output: "htmlAndMathml"
  });
}
