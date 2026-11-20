// `@horagon/sdk/errors`: the error class, its codes and the cross-build check, without the rest
// of the SDK. Check errors with `isHoragonError`, not `instanceof`: an app that loads both the
// ESM and the CJS build has two HoragonError classes.
export * from './errors'
