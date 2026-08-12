# AGENTS.md

## Project purpose

This is a static, framework-free Vite application for exploring numerical
eigenmodes of the scalar two-dimensional wave equation on arbitrary fixed-edge
domains. It must remain usable without a backend and deploy safely at a GitHub
Pages repository subpath.

## Mathematical invariants

- The model is a tensioned membrane: `-Delta phi_n = lambda_n phi_n`, with
  homogeneous Dirichlet displacement on the domain boundary and
  `omega_n = c sqrt(lambda_n)`. Do not describe it as Kirchhoff plate bending.
- Every binary shape is discretized with the five-point Laplacian. The diagonal
  remains four at boundary-adjacent unknowns; missing neighbors are zero-valued
  exterior nodes. A neighbor-count diagonal would incorrectly impose graph or
  Neumann behavior.
- The UI contains exactly 20 modes ordered by increasing frequency. Collapse
  repeated eigenfrequencies and keep one representative of each degenerate
  eigenspace.
- Animation timing preserves `omega_n / omega_1` exactly. The fundamental has a
  deliberately slow 10-second illustrative cycle, so `T_n = 10 omega_1 / omega_n`.
- Normalize every rendered spatial eigenvector by its maximum absolute value.
  Color and height encode instantaneous signed displacement; the outline and
  grid must keep the surface understandable without color alone. Do not add a
  nodal-line overlay.
- The MIT spiral predicate must remain the level set from Dense-and-Sparse.ipynb:
  `exp(-(r - theta/(2*pi) - 0.5)^2 / 0.3^2) - 0.5 > 0`.

## Architecture

- Keep semantic HTML and lifecycle in `index.html` and `src/app.ts`.
- Keep shape metadata, predicates, rasterization, and connected-component
  cleanup in `src/shapes/`.
- Keep the Float64 banded-Cholesky/Lanczos eigenproblem and its worker protocol
  in `src/solver/`; only final full-grid fields become Float32.
- Keep accepted shape/mode data, Three.js resources, phase, camera state, and
  animation scheduling in `src/membrane/`.
- Keep compact DOM controls and drawing behavior in `src/ui/`.
- Preserve Vite's relative `base: "./"` and reproducible `npm ci` workflow.

## UX and verification

- The membrane is the full-viewport protagonist. Desktop controls overlay it
  and must not reserve a permanent sidebar.
- Mode and parameter controls are native, keyboard accessible, and at least 44
  CSS pixels across their interactive axis.
- Preserve solve cancellation, cached predefined spectra, WebGL retry, clean
  view, reduced-motion behavior, page-visibility pausing, and keyboard camera
  controls.
- A custom outline is closed and filled when the pointer is released. Reject
  tiny domains and retain one four-connected component.
- Run unit tests, typecheck, production build, browser smoke tests, and visual
  desktop/mobile inspection after interaction or layout changes.
