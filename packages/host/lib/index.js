//#region src/index.ts
/** Host-side Orb plugin. Stage 0 only proves the package can be loaded. */
/** Cordis plugin name. */
const name = "orb-host";
/** Mount nothing. Later stages register services from this function. */
function apply() {}
//#endregion
export { apply, name };
