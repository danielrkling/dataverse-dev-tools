/**
 * Single shared Lit instance, imported from the CDN like every other
 * dependency in index.html's import map.
 *
 * Why not the npm package? Vite's dev-server dep optimizer force-resolves
 * Lit's "development" export (overrideConditions includes "development"),
 * which emits "Lit is in dev mode" + "Multiple versions of Lit loaded"
 * warnings (the Web Awesome CDN bundle ships its own Lit copy, so two
 * registrations are unavoidable). esm.sh serves the production build, which
 * has those version checks compiled out entirely.
 */
export * from "https://esm.sh/lit@3.3.1";
