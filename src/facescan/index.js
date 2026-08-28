// Barrel export for the PURE facescan modules only (spec §5 / plan Task 3).
//
// Runtime modules (createLandmarker from ./landmarker.js, useFaceScan from
// ./useFaceScan.js) pull in vue and @mediapipe/tasks-vision and are
// deliberately NOT re-exported here — consumers import them from their own
// paths. This keeps node-env tests (and any pure-module consumer) that
// import '@/facescan' from ever evaluating vue/@mediapipe.

export { CATEGORIES, frameIntensities } from './features.js'
export { buildProfile, pAbove } from './profile.js'
export { DEFAULT_THRESHOLDS, scoreCategory, scoreAll } from './scoring.js'
export { recalibrate } from './calibration.js'
