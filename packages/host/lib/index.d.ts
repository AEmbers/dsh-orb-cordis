//#region src/index.d.ts
/** Host-side Orb plugin. Stage 0 only proves the package can be loaded. */
/** Cordis plugin name. */
declare const name = "orb-host";
/** Mount nothing. Later stages register services from this function. */
declare function apply(): void;
//#endregion
export { apply, name };