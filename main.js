// main.js (glowing pulse version)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { BrightnessContrastShader } from 'three/addons/shaders/BrightnessContrastShader.js';
import { HueSaturationShader } from 'three/addons/shaders/HueSaturationShader.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';

/* ---------------- Renderer ---------------- */
const renderer = new THREE.WebGLRenderer({
  antialias: false,                 // faster
  logarithmicDepthBuffer: true,
  powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

/* ---------------- Postprocessing (Composer + Passes) ---------------- */
let composer, renderPass, fxaaPass, bcPass, hsPass, vignettePass, bloomPass, edgeBlurPass;

// Simple radial edge blur shader (blur increases toward screen edges)
const EdgeBlurShader = {
  uniforms: {
    tDiffuse:   { value: null },
    resolution: { value: new THREE.Vector2(innerWidth, innerHeight) },
    maxRadius:  { value: 8.0 },   // pixels at the very edge
    falloff:    { value: 1.6 },   // higher = blur starts closer to edge
    strength:   { value: 1.0 },   // mix amount of blur
    center:     { value: new THREE.Vector2(0.5, 0.5) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4( position, 1.0 );
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2  resolution;
    uniform float maxRadius;
    uniform float falloff;
    uniform float strength;
    uniform vec2  center;
    varying vec2  vUv;

    // 8-tap kernel (cross + diagonals)
    vec4 sampleBlur(vec2 uv, float radiusPx) {
      vec2 texel = radiusPx / resolution;
      vec4 c = texture2D(tDiffuse, uv) * 0.227027; // center weight (approx gaussian)
      c += texture2D(tDiffuse, uv + vec2(texel.x, 0.0)) * 0.1945946;
      c += texture2D(tDiffuse, uv - vec2(texel.x, 0.0)) * 0.1945946;
      c += texture2D(tDiffuse, uv + vec2(0.0, texel.y)) * 0.1216216;
      c += texture2D(tDiffuse, uv - vec2(0.0, texel.y)) * 0.1216216;
      // light diagonal contribution
      c += texture2D(tDiffuse, uv + vec2(texel.x, texel.y)) * 0.0702703;
      c += texture2D(tDiffuse, uv + vec2(-texel.x, texel.y)) * 0.0702703;
      c += texture2D(tDiffuse, uv + vec2(texel.x, -texel.y)) * 0.0702703;
      c += texture2D(tDiffuse, uv + vec2(-texel.x, -texel.y)) * 0.0702703;
      return c;
    }

    void main() {
      vec2 uv = vUv;
      // aspect-corrected distance from center
      vec2 d = uv - center;
      d.x *= resolution.x / resolution.y;
      float dist = length(d);              // 0 at center
      float edge = clamp(dist * 2.0, 0.0, 1.0); // ~1 near edges
      float mask = pow(edge, falloff);

      float radius = mask * maxRadius;
      vec4 sharp = texture2D(tDiffuse, uv);
      vec4 blurred = sampleBlur(uv, radius);
      gl_FragColor = mix(sharp, blurred, strength * mask);
    }
  `
};

function initPost() {
  composer = new EffectComposer(renderer);
  renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.6, 0.4, 0.95);
  bloomPass.enabled = false;
  composer.addPass(bloomPass);


  bcPass = new ShaderPass(BrightnessContrastShader);
  bcPass.material.uniforms.brightness.value = 0.0; // -1..1
  bcPass.material.uniforms.contrast.value = 0.0;   // -1..1
  bcPass.enabled = false;
  composer.addPass(bcPass);

  hsPass = new ShaderPass(HueSaturationShader);
  hsPass.material.uniforms.hue.value = 0.0;        // -1..1 (radians/pi)
  hsPass.material.uniforms.saturation.value = 0.0; // -1..1
  hsPass.enabled = false;
  composer.addPass(hsPass);

  vignettePass = new ShaderPass(VignetteShader);
  vignettePass.material.uniforms.offset.value = 1.0;   // >=0
  vignettePass.material.uniforms.darkness.value = 0.6; // 0..1
  vignettePass.enabled = false;
  composer.addPass(vignettePass);

  // Edge blur (disabled by default)
  edgeBlurPass = new ShaderPass(EdgeBlurShader);
  edgeBlurPass.enabled = false;
  composer.addPass(edgeBlurPass);

  fxaaPass = new ShaderPass(FXAAShader);
  fxaaPass.enabled = false; // toggle with hotkey
  composer.addPass(fxaaPass);

  updatePostSizes();
}

function updatePostSizes() {
  if (!composer) return;
  composer.setSize(innerWidth, innerHeight);
  if (bloomPass) bloomPass.setSize(innerWidth, innerHeight);
  if (edgeBlurPass?.material?.uniforms?.resolution) {
    edgeBlurPass.material.uniforms.resolution.value.set(innerWidth, innerHeight);
  }
  if (fxaaPass) {
    const px = Math.min(devicePixelRatio, 1.5);
    fxaaPass.material.uniforms[ 'resolution' ].value.set(1 / (innerWidth * px), 1 / (innerHeight * px));
  }
}

/* ---------------- Scene & Camera ---------------- */
const scene = new THREE.Scene();
scene.background = new THREE.Color(0);
let fogEnabled = false;
let fogDensity = 0.12; // thicker default
function updateFog() {
  // Use custom shader fog; do not use Three.js scene.fog to avoid uniform mismatch
  const u = points?.material?.uniforms;
  if (u) {
    u.uFogEnabled.value = fogEnabled ? 1.0 : 0.0;
    u.uFogDensity.value = fogDensity;
    const c = scene.background;
    if (c && u.uFogColor) u.uFogColor.value.set(c.r, c.g, c.b);
  }
}

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1e7);
camera.position.set(0, 0, 2);

/* ---------------- Controls ---------------- */
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

/* ---------------- Helpers (optional) ---------------- */
scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const grid = new THREE.GridHelper(10, 10);
grid.material.transparent = true;
grid.material.opacity = 0.12;
scene.add(grid);
grid.visible = false;

// initialize composer after scene/camera exist
initPost();

/* ---------------- UI Panel ---------------- */
function setupUI() {
  const $ = (id) => document.getElementById(id);
  const panel = $('ui-panel');
  const toggleBtn = $('ui-toggle');
  if (!panel || !toggleBtn) return;

  const setVal = (id, v, fmt) => { const el = $(id); if (el) el.textContent = fmt ? fmt(v) : String(v); };
  const getU = () => points?.material?.uniforms;

  // Prevent UI interactions from moving the camera
  ['wheel','pointerdown','touchstart','keydown'].forEach(ev => {
    panel.addEventListener(ev, (e) => e.stopPropagation());
  });

  const updateToggleLabel = () => {
    const open = !panel.classList.contains('hidden');
    toggleBtn.textContent = open ? 'Close Controls' : 'Open Controls';
    toggleBtn.setAttribute('aria-expanded', String(open));
  };
  toggleBtn.addEventListener('click', () => {
    panel.classList.toggle('hidden');
    updateToggleLabel();
  });
  // Ensure initial label matches initial state
  updateToggleLabel();

  // Grab elements
  const el = {
    modelBtn: $('ui-model-btn'),
    density: $('ui-density'), psize: $('ui-psize'), worldsize: $('ui-worldsize'), atten: $('ui-atten'), grid: $('ui-grid'),
    scatter: $('ui-scatter'),
    windEnabled: $('ui-wind-enabled'), windAmp: $('ui-wind-amp'), windFreq: $('ui-wind-freq'), windSpatial: $('ui-wind-spatial'),
    waveLength: $('ui-wave-length'), waveSpeed: $('ui-wave-speed'), waveWidth: $('ui-wave-width'), waveGamma: $('ui-wave-gamma'),
    edgeBlur: $('ui-edgeblur'), edgeBlurAmt: $('ui-edgeblur-amt'),
    fog: $('ui-fog'), fogDensity: $('ui-fog-density'),
    bg: $('ui-bg'),
    bloom: $('ui-bloom'), bloomStrength: $('ui-bloom-strength'), vignette: $('ui-vignette'), vignetteDark: $('ui-vignette-dark'),
    bc: $('ui-bc'), contrast: $('ui-contrast'), bright: $('ui-bright'), hs: $('ui-hs'), sat: $('ui-sat'), hue: $('ui-hue'), fxaa: $('ui-fxaa'),
  };

  // Helpers
  function refreshUI() {
    // Points
    if (el.modelBtn) { try { el.modelBtn.textContent = (models[modelIndex] || '').split('/').pop(); } catch {} }
    if (el.density) { el.density.value = String(keepRatio); setVal('ui-density-val', Number(keepRatio).toFixed(2)); }
    if (el.psize)   { el.psize.value = String(pointSizePx); setVal('ui-psize-val', Number(pointSizePx).toFixed(2)); }
    if (el.grid)    { el.grid.checked = !!grid.visible; }

    const u = getU();
    if (u) {
      if (el.worldsize) el.worldsize.checked = u.uUseWorldSize.value > 0.5;
      if (el.atten)     el.atten.checked     = u.uSizeAttenEnabled.value > 0.5;
      if (el.scatter)   { el.scatter.value = String(u.uScatterAmp.value ?? scatterAmp); setVal('ui-scatter-val', (u.uScatterAmp.value ?? scatterAmp).toFixed(3)); }
      // no base color controls in UI
      if (el.windEnabled) el.windEnabled.checked = u.uWindEnabled.value > 0.5;
      if (el.windAmp)   { el.windAmp.value   = String(u.uWindAmp.value);   setVal('ui-wind-amp-val', u.uWindAmp.value.toFixed(3)); }
      if (el.windFreq)  { el.windFreq.value  = String(u.uWindFreq.value);  setVal('ui-wind-freq-val', u.uWindFreq.value.toFixed(2)); }
      if (el.windSpatial){ el.windSpatial.value= String(u.uWindSpatial.value); setVal('ui-wind-spatial-val', u.uWindSpatial.value.toFixed(2)); }

      if (el.waveLength){ el.waveLength.value= String(u.uWaveLength.value); setVal('ui-wave-length-val', u.uWaveLength.value.toFixed(2)); }
      if (el.waveSpeed) { el.waveSpeed.value = String(u.uWaveSpeed.value);  setVal('ui-wave-speed-val', u.uWaveSpeed.value.toFixed(2)); }
      if (el.waveWidth) { el.waveWidth.value = String(u.uWaveWidth.value);  setVal('ui-wave-width-val', u.uWaveWidth.value.toFixed(2)); }
      if (el.waveGamma) { el.waveGamma.value = String(u.uBandGamma.value);  setVal('ui-wave-gamma-val', u.uBandGamma.value.toFixed(2)); }
    }

    // Fog
    if (el.fog) el.fog.checked = fogEnabled;
    if (el.fogDensity) { el.fogDensity.value = String(fogDensity); setVal('ui-fog-density-val', fogDensity.toFixed(3)); }
    if (el.bg) {
      try {
        const hex = '#' + scene.background.getHexString();
        el.bg.value = hex;
        setVal('ui-bg-val', hex.toUpperCase());
      } catch {}
    }

    // Post FX
    if (el.edgeBlur) { el.edgeBlur.checked = !!edgeBlurPass?.enabled; }
    if (el.edgeBlurAmt) {
      const v = edgeBlurPass?.material?.uniforms?.maxRadius?.value ?? 8.0;
      el.edgeBlurAmt.value = String(v);
      setVal('ui-edgeblur-amt-val', Number(v).toFixed(1));
    }
    if (el.bloom) { el.bloom.checked = !!bloomPass?.enabled; }
    if (el.bloomStrength) { const v = bloomPass?.strength ?? 0.6; el.bloomStrength.value = String(v); setVal('ui-bloom-strength-val', v.toFixed(2)); }
    if (el.vignette) { el.vignette.checked = !!vignettePass?.enabled; }
    if (el.vignetteDark) { const v = vignettePass?.material?.uniforms?.darkness?.value ?? 0.6; el.vignetteDark.value = String(v); setVal('ui-vignette-dark-val', v.toFixed(2)); }
    if (el.bc) { el.bc.checked = !!bcPass?.enabled; }
    if (el.contrast) { const v = bcPass?.material?.uniforms?.contrast?.value ?? 0.0; el.contrast.value = String(v); setVal('ui-contrast-val', v.toFixed(2)); }
    if (el.bright) { const v = bcPass?.material?.uniforms?.brightness?.value ?? 0.0; el.bright.value = String(v); setVal('ui-bright-val', v.toFixed(2)); }
    if (el.hs) { el.hs.checked = !!hsPass?.enabled; }
    if (el.sat) { const v = hsPass?.material?.uniforms?.saturation?.value ?? 0.0; el.sat.value = String(v); setVal('ui-sat-val', v.toFixed(2)); }
    if (el.hue) { const v = hsPass?.material?.uniforms?.hue?.value ?? 0.0; el.hue.value = String(v); setVal('ui-hue-val', v.toFixed(2)); }
    if (el.fxaa) { el.fxaa.checked = !!fxaaPass?.enabled; }
  }

  // Allow external triggers to refresh the panel
  window.addEventListener('ui-refresh', refreshUI);

  // Wiring events
  el.modelBtn?.addEventListener('click', () => {
    modelIndex = (modelIndex + 1) % models.length;
    const path = models[modelIndex];
    el.modelBtn.textContent = path.split('/').pop();
    loadModel(path);
  });

  el.density?.addEventListener('input', () => {
    keepRatio = Math.max(0.02, Math.min(1, Number(el.density.value)));
    setVal('ui-density-val', keepRatio.toFixed(2));
    buildPoints();
  });
  el.psize?.addEventListener('input', () => {
    pointSizePx = Math.max(0.5, Math.min(12, Number(el.psize.value)));
    setVal('ui-psize-val', pointSizePx.toFixed(2));
    buildPoints();
    const u = getU();
    if (u && u.uUseWorldSize.value > 0.5) {
      const pxPerUnit = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
      const refDist = u.uSizeAttenRef.value || camera.position.distanceTo(controls.target);
      u.uWorldSize.value = Math.max(1e-5, pointSizePx * refDist / pxPerUnit);
    }
  });

  el.worldsize?.addEventListener('change', () => {
    const u = getU(); if (!u) return;
    u.uUseWorldSize.value = el.worldsize.checked ? 1.0 : 0.0;
    if (u.uUseWorldSize.value > 0.5) {
      const pxPerUnit = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
      const refDist = u.uSizeAttenRef.value || camera.position.distanceTo(controls.target);
      u.uPxPerUnit.value = pxPerUnit;
      u.uWorldSize.value = Math.max(1e-5, pointSizePx * refDist / pxPerUnit);
    }
  });
  el.atten?.addEventListener('change', () => {
    const u = getU(); if (!u) return; u.uSizeAttenEnabled.value = el.atten.checked ? 1.0 : 0.0;
  });
  el.grid?.addEventListener('change', () => { grid.visible = !!el.grid.checked; });

  // Scatter
  el.scatter?.addEventListener('input', () => {
    scatterAmp = Math.max(0, Math.min(1, Number(el.scatter.value)));
    setVal('ui-scatter-val', scatterAmp.toFixed(3));
    const u = getU(); if (u && u.uScatterAmp) u.uScatterAmp.value = scatterAmp;
  });

  // removed RGB/vertex color handlers

  // Wind
  el.windEnabled?.addEventListener('change', () => { const u = getU(); if (!u) return; u.uWindEnabled.value = el.windEnabled.checked ? 1.0 : 0.0; });
  el.windAmp?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uWindAmp.value = Number(el.windAmp.value); setVal('ui-wind-amp-val', u.uWindAmp.value.toFixed(3)); });
  el.windFreq?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uWindFreq.value = Number(el.windFreq.value); setVal('ui-wind-freq-val', u.uWindFreq.value.toFixed(2)); });
  el.windSpatial?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uWindSpatial.value = Number(el.windSpatial.value); setVal('ui-wind-spatial-val', u.uWindSpatial.value.toFixed(2)); });

  // Wave
  el.waveLength?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uWaveLength.value = Number(el.waveLength.value); setVal('ui-wave-length-val', u.uWaveLength.value.toFixed(2)); });
  el.waveSpeed?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uWaveSpeed.value = Number(el.waveSpeed.value); setVal('ui-wave-speed-val', u.uWaveSpeed.value.toFixed(2)); });
  el.waveWidth?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uWaveWidth.value = Number(el.waveWidth.value); setVal('ui-wave-width-val', u.uWaveWidth.value.toFixed(2)); });
  el.waveGamma?.addEventListener('input', () => { const u = getU(); if (!u) return; u.uBandGamma.value = Number(el.waveGamma.value); setVal('ui-wave-gamma-val', u.uBandGamma.value.toFixed(2)); });

  // Fog
  el.fog?.addEventListener('change', () => { fogEnabled = !!el.fog.checked; updateFog(); });
  el.fogDensity?.addEventListener('input', () => {
    fogDensity = Math.max(0, Math.min(2.0, Number(el.fogDensity.value)));
    updateFog();
    setVal('ui-fog-density-val', fogDensity.toFixed(3));
  });
  el.bg?.addEventListener('input', () => {
    try {
      const hex = el.bg.value || '#000000';
      scene.background.set(hex);
      setVal('ui-bg-val', hex.toUpperCase());
      updateFog();
    } catch (e) {
      console.warn('Invalid color:', e);
    }
  });

  // Post FX
  el.edgeBlur?.addEventListener('change', () => { if (edgeBlurPass) edgeBlurPass.enabled = el.edgeBlur.checked; });
  el.edgeBlurAmt?.addEventListener('input', () => {
    if (!edgeBlurPass) return; const v = Number(el.edgeBlurAmt.value);
    if (edgeBlurPass.material?.uniforms?.maxRadius) edgeBlurPass.material.uniforms.maxRadius.value = v;
    setVal('ui-edgeblur-amt-val', v.toFixed(1));
  });
  el.bloom?.addEventListener('change', () => { if (bloomPass) bloomPass.enabled = el.bloom.checked; });
  el.bloomStrength?.addEventListener('input', () => { if (!bloomPass) return; bloomPass.strength = Number(el.bloomStrength.value); setVal('ui-bloom-strength-val', bloomPass.strength.toFixed(2)); });
  el.vignette?.addEventListener('change', () => { if (vignettePass) vignettePass.enabled = el.vignette.checked; });
  el.vignetteDark?.addEventListener('input', () => { const u = vignettePass?.material?.uniforms?.darkness; if (!u) return; u.value = Number(el.vignetteDark.value); setVal('ui-vignette-dark-val', u.value.toFixed(2)); });
  el.bc?.addEventListener('change', () => { if (bcPass) bcPass.enabled = el.bc.checked; });
  el.contrast?.addEventListener('input', () => { const u = bcPass?.material?.uniforms?.contrast; if (!u) return; u.value = Number(el.contrast.value); setVal('ui-contrast-val', u.value.toFixed(2)); });
  el.bright?.addEventListener('input', () => { const u = bcPass?.material?.uniforms?.brightness; if (!u) return; u.value = Number(el.bright.value); setVal('ui-bright-val', u.value.toFixed(2)); });
  el.hs?.addEventListener('change', () => { if (hsPass) hsPass.enabled = el.hs.checked; });
  el.sat?.addEventListener('input', () => { const u = hsPass?.material?.uniforms?.saturation; if (!u) return; u.value = Number(el.sat.value); setVal('ui-sat-val', u.value.toFixed(2)); });
  el.hue?.addEventListener('input', () => { const u = hsPass?.material?.uniforms?.hue; if (!u) return; u.value = Number(el.hue.value); setVal('ui-hue-val', u.value.toFixed(2)); });
  el.fxaa?.addEventListener('change', () => { if (fxaaPass) fxaaPass.enabled = el.fxaa.checked; });

  // Initial sync
  refreshUI();

  // Note: event handlers that call buildPoints also call refreshUI()
}

// (moved) UI initialization happens later after key vars are defined

/* ---------------- Utilities ---------------- */
// Subsample utility (keeps ~keepRatio of points)
function subsampleGeometry(sourceGeom, keepRatio = 1) {
  if (keepRatio >= 0.999) return sourceGeom;

  const pos = sourceGeom.getAttribute('position');
  const col = sourceGeom.getAttribute('color'); // may be undefined
  const count = pos.count;

  const target = Math.max(1, Math.floor(count * keepRatio));
  const stride = Math.max(1, Math.floor(count / target));
  const kept = Math.ceil(count / stride);

  const positions = new Float32Array(kept * 3);
  const colors = col ? new Uint8Array(kept * 3) : null;

  let w = 0;
  for (let i = 0; i < count; i += stride) {
    positions[w * 3 + 0] = pos.getX(i);
    positions[w * 3 + 1] = pos.getY(i);
    positions[w * 3 + 2] = pos.getZ(i);
    if (colors) {
      colors[w * 3 + 0] = Math.round((col.getX(i) ?? 1) * 255);
      colors[w * 3 + 1] = Math.round((col.getY(i) ?? 1) * 255);
      colors[w * 3 + 2] = Math.round((col.getZ(i) ?? 1) * 255);
    }
    w++;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true)); // normalized Uint8
  return g;
}

// Wave glow shader: a moving front that brightens/enlarges points as it passes.
function makeGlowMaterial(hasVertexColor, baseSizePx = 3.0) {
  const uniforms = {
    uTime:        { value: 0.0 },
    uDPR:         { value: Math.min(devicePixelRatio, 1.5) },
    uBaseSize:    { value: baseSizePx }, // px
    uPulseAmp:    { value: 1.2 },        // how much points grow at the wave front
    uGlowBoost:   { value: 1.1 },        // brightness at the front
    uColor:       { value: new THREE.Color(0xffffff) },
    uUseVertexColor: { value: hasVertexColor ? 1 : 0 },

    // Size attenuation (0 = off, 1 = on). Ref distance where size is unchanged.
    uSizeAttenEnabled: { value: 0.0 },
    uSizeAttenRef:     { value: 2.0 },

    // World-size points (true world units → pixels via projection)
    uUseWorldSize: { value: 1.0 },  // default ON for this experiment
    uWorldSize:    { value: 0.015 }, // diameter in world units
    uPxPerUnit:    { value: 1.0 },   // pixels per world unit (CSS px)
    // Random scatter amount (world units)
    uScatterAmp:   { value: scatterAmp },

    // --- wave controls ---
    // We normalized your model so the largest side ≈ 2 world units.
    // Wave length/speed below are in those same units.
    uWaveCenter:  { value: new THREE.Vector3(0, 0, 0) }, // center of circular wave
    uWaveLength:  { value: 0.6 },  // distance between consecutive fronts (in world units)
    uWaveSpeed:   { value: 0.6 },  // units per second that the front moves
    uWaveWidth:   { value: 0.15 }, // thickness of the bright band (0..0.5)
    uBandGamma:   { value: 1.5 },  // sharpness of the band response

    // --- wind sway controls (world units) ---
    uWindDir:     { value: new THREE.Vector3(1, 0, 0) }, // predominant wind direction
    uWindAmp:     { value: 0.02 },  // max displacement at tips (world units)
    uWindFreq:    { value: 0.8 },   // temporal frequency (Hz)
    uWindSpatial: { value: 1.5 },   // spatial frequency along x/z
    uWindEnabled: { value: 1.0 },   // 1 = on, 0 = off

    // --- custom fog uniforms ---
    uFogEnabled: { value: fogEnabled ? 1.0 : 0.0 },
    uFogDensity: { value: fogDensity },
    uFogColor:   { value: new THREE.Color(scene.background) },
  };

  const vertexShader = `
    precision mediump float;
    uniform float uTime;
    uniform float uDPR;
    uniform float uBaseSize;
    uniform float uPulseAmp;
    uniform float uSizeAttenEnabled;
    uniform float uSizeAttenRef;
    // World-size uniforms
    uniform float uUseWorldSize;
    uniform float uWorldSize;
    uniform float uPxPerUnit;
    uniform float uScatterAmp;

    uniform vec3  uWaveCenter;
    uniform float uWaveLength;
    uniform float uWaveSpeed;
    uniform float uWaveWidth;
    uniform float uBandGamma;

    attribute vec3 color;
    // Wind uniforms
    uniform vec3  uWindDir;
    uniform float uWindAmp;
    uniform float uWindFreq;
    uniform float uWindSpatial;
    uniform float uWindEnabled;
    varying vec3  vColor;
    varying float vPulse;
    varying float vViewZ;

    void main() {
      // Start from local position
      vec3 p = position;

      // Height factor (0 at base, 1 at top). Model is roughly in [-1,1] Y.
      float h = clamp(p.y * 0.5 + 0.5, 0.0, 1.0);

      // Stable random direction per point; displace by uScatterAmp
      float h1 = fract(sin(dot(p.xyz, vec3(127.1, 311.7,  74.7))) * 43758.5453);
      float h2 = fract(sin(dot(p.yzx, vec3(269.5, 183.3, 246.1))) * 43758.5453);
      float h3 = fract(sin(dot(p.zxy, vec3(113.5, 271.9, 124.6))) * 43758.5453);
      vec3 randDir = normalize(vec3(h1 * 2.0 - 1.0, h2 * 2.0 - 1.0, h3 * 2.0 - 1.0) + 1e-4);
      p += randDir * uScatterAmp;

      // Pseudo-random per-point phase for variation
      float hash = fract(sin(dot(p.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);

      // Time-varying wind direction (slowly rotates) blended with user dir
      vec3 rotDir = normalize(vec3(cos(uTime * 0.05), 0.0, sin(uTime * 0.05)));
      vec3 windDir = normalize(normalize(uWindDir) * 0.6 + rotDir * 0.4);

      // Smooth sinusoidal sway with spatial variation and per-point phase
      float sway = sin(uTime * uWindFreq + (p.x + p.z) * uWindSpatial + hash * 6.2831853);

      // Apply displacement increasing with height so bases stay steadier
      p += windDir * (uWindAmp * sway * (0.2 + 0.8 * h)) * uWindEnabled;

      // World position for spatial wave
      vec3 worldPos = (modelMatrix * vec4(p, 1.0)).xyz;

      // Radial distance from wave center (circular/spherical wave)
      float coord = length(worldPos - uWaveCenter);

      // Phase of the traveling wave (0..1 wraps every wavelength)
      float phase = fract( (coord / max(uWaveLength, 1e-5)) - uTime * uWaveSpeed );

      // Distance to nearest wave front (fronts at phase=0 and 1)
      float distToFront = min(phase, 1.0 - phase); // in [0, 0.5]

      // Convert to a soft band: 1 at front, 0 away from it
      float band = smoothstep(uWaveWidth, 0.0, distToFront); // thinner band -> sharper front
      vPulse = pow(band, uBandGamma);

      // Point size: choose screen-space constant or world-space diameter
      vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
      float dist = max(0.01, -mvPosition.z);
      float sizeScreenPx = uBaseSize; // constant pixel size
      float sizeWorldPx  = uWorldSize * (uPxPerUnit / dist); // projection-based pixels
      float basePx = mix(sizeScreenPx, sizeWorldPx, uUseWorldSize);
      // Optional legacy attenuation for screen-space mode
      float atten = mix(1.0, clamp(uSizeAttenRef / dist, 0.1, 4.0), uSizeAttenEnabled * (1.0 - uUseWorldSize));
      float sizePx = basePx * (1.0 + uPulseAmp * vPulse) * atten;
      // As scatter increases to 0.5, shrink point size to 0
      float scatterScale = clamp(1.0 - (uScatterAmp / 0.5), 0.0, 1.0);
      sizePx *= scatterScale;
      gl_PointSize = sizePx * uDPR;
      vColor = color; // will be (0,0,0) if no vertex colors bound
      vViewZ = dist;
      gl_Position = projectionMatrix * mvPosition;
    }
  `;

  const fragmentShader = `
    precision mediump float;

uniform vec3  uColor;
uniform float uGlowBoost;
uniform float uUseVertexColor;
uniform float uScatterAmp;
uniform float uFogEnabled;
uniform float uFogDensity;
uniform vec3  uFogColor;

varying vec3  vColor;
varying float vPulse;
varying float vViewZ;

void main() {
  // Circular points
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;

  vec3 base = mix(uColor, vColor, uUseVertexColor);
  vec3 col  = base * (1.0 + uGlowBoost * vPulse);

  // Keep points fully opaque; size is controlled in vertex
  float alpha = 1.0;

  // Exponential squared fog based on view-space depth (approx via gl_FragCoord)
  // We approximate view depth using gl_FragCoord.z in [0,1] mapped by density scalar.
  // For point sprites, this is sufficient for a soft atmospheric effect.
  if (uFogEnabled > 0.5) {
    float f = 1.0 - exp(-pow(uFogDensity * vViewZ, 2.0));
    col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
  }

  gl_FragColor = vec4(col, alpha);
}
  `;

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
}

/* ---------------- Load PLY & Build Points ---------------- */
const loader = new PLYLoader();

let originalGeom = null; // unmodified, for re-subsampling
let points = null;       // THREE.Points instance

let keepRatio = 0.18;    // ↓ fewer points for speed (try 0.10–0.25)
let pointSizePx = 3.0;   // ↑ base point size (pixels)
let useScreenSize = true; // kept for API parity; shader uses screen-space size
let scatterAmp = 0.0;    // random displacement amplitude (world units)

function buildPoints() {
  if (!originalGeom) return;

  const g = subsampleGeometry(originalGeom, keepRatio);
  g.computeBoundingBox();

  const hasColor = !!g.getAttribute('color');
  const mat = makeGlowMaterial(hasColor, pointSizePx);

  if (points) {
    points.geometry.dispose();
    points.material.dispose();
    scene.remove(points);
  }
  points = new THREE.Points(g, mat);
  points.frustumCulled = true;
  scene.add(points);

  // Initialize camera-dependent uniforms for world-size mode
  const u = points.material.uniforms;
  if (u) {
    const pxPerUnit = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
    u.uPxPerUnit.value = pxPerUnit; // CSS px per world unit
    // If using world-size, match current pixel size choice at current distance
    if (u.uUseWorldSize.value > 0.5) {
      const refDist = camera.position.distanceTo(controls.target);
      u.uWorldSize.value = Math.max(1e-5, pointSizePx * refDist / pxPerUnit);
    }
  }
  // Sync fog uniforms to current settings
  updateFog();
}

// Available models and current index
const models = [
  'point/tree-bush.ply',
  'point/tree-stump-2.ply',
  'point/room.ply',
];
let modelIndex = 0;

function loadModel(path) {
  console.log('[PLY] loading:', path);
  loader.load(
    path,
    (geom) => {
      // recentre to origin
      geom.computeBoundingBox();
      const bb = geom.boundingBox;
      const cx = (bb.min.x + bb.max.x) / 2;
      const cy = (bb.min.y + bb.max.y) / 2;
      const cz = (bb.min.z + bb.max.z) / 2;
      geom.translate(-cx, -cy, -cz);

      // normalize scale to ~2 world units
      const maxDim = Math.max(
        bb.max.x - bb.min.x,
        bb.max.y - bb.min.y,
        bb.max.z - bb.min.z
      ) || 1;
      const scale = 2 / maxDim;
      geom.scale(scale, scale, scale);

      // rotate model 30 degrees to the left (counterclockwise around Y)
      geom.rotateY(THREE.MathUtils.degToRad(30));

      originalGeom = geom;
      buildPoints(); // initial draw

      // frame camera to points
      const box = new THREE.Box3().setFromObject(points);
      const size = new THREE.Vector3(), center = new THREE.Vector3();
      box.getSize(size); box.getCenter(center);
      const md = Math.max(size.x, size.y, size.z) || 1;
      const dist = (md / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.2;
      camera.position.copy(center).add(new THREE.Vector3(0, 0, dist));
      camera.near = Math.max(dist / 1e5, 0.01);
      camera.far = dist * 1e5;
      camera.updateProjectionMatrix();
      controls.target.copy(center);
      controls.update();

      // Set size attenuation reference distance to the framing distance
      if (points && points.material && points.material.uniforms) {
        const u = points.material.uniforms;
        u.uSizeAttenRef.value = dist;
        // Update projection scale for world-size conversion
        u.uPxPerUnit.value = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
        // Choose world size so initial pixel size matches current base size at dist
        if (u.uUseWorldSize.value > 0.5) {
          u.uWorldSize.value = Math.max(1e-5, pointSizePx * dist / u.uPxPerUnit.value);
        }
      }

      console.log('[PLY] points:', geom.getAttribute('position')?.count ?? 0,
                  'hasColor:', !!geom.getAttribute('color'));
      console.log(`[viewer] keepRatio=${keepRatio}, pointSizePx=${pointSizePx}`);
      // Ask UI to sync with current material uniforms
      try { window.dispatchEvent(new Event('ui-refresh')); } catch {}

      // Update the model button text if present
      try {
        const btn = document.getElementById('ui-model-btn');
        if (btn) btn.textContent = path.split('/').pop();
      } catch {}
    },
    undefined,
    (err) => console.error('PLY load error:', err)
  );
}

// Initial model
loadModel(models[modelIndex]);
updateFog();

/* ---------------- Hotkeys to tune live ----------------
   - / =  → density down/up
   [ / ]  → point size down/up
------------------------------------------------------- */
addEventListener('keydown', (e) => {
  if (!originalGeom) return;

  if (e.key === '-') {        // fewer points
    keepRatio = Math.max(0.02, keepRatio * 0.8);
    buildPoints();
    console.log('[viewer] keepRatio ->', keepRatio.toFixed(3));
  }
  if (e.key === '=') {        // more points
    keepRatio = Math.min(1.0, keepRatio / 0.8);
    buildPoints();
    console.log('[viewer] keepRatio ->', keepRatio.toFixed(3));
  }
  if (e.key === '[') {        // smaller points
    pointSizePx = Math.max(0.5, pointSizePx * 0.9);
    buildPoints();
    // If world-size mode is active, keep world size matching the new target pixel size at ref distance
    const u = points?.material?.uniforms;
    if (u && u.uUseWorldSize.value > 0.5) {
      const pxPerUnit = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
      const refDist = u.uSizeAttenRef.value || camera.position.distanceTo(controls.target);
      u.uWorldSize.value = Math.max(1e-5, pointSizePx * refDist / pxPerUnit);
    }
    console.log('[viewer] pointSizePx ->', pointSizePx.toFixed(2));
  }
  if (e.key === ']') {        // bigger points
    pointSizePx = Math.min(12.0, pointSizePx / 0.9);
    buildPoints();
    const u = points?.material?.uniforms;
    if (u && u.uUseWorldSize.value > 0.5) {
      const pxPerUnit = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
      const refDist = u.uSizeAttenRef.value || camera.position.distanceTo(controls.target);
      u.uWorldSize.value = Math.max(1e-5, pointSizePx * refDist / pxPerUnit);
    }
    console.log('[viewer] pointSizePx ->', pointSizePx.toFixed(2));
  }

  // Toggle wind sway
  if (e.key === 't') {
    const u = points?.material?.uniforms?.uWindEnabled;
    if (u) {
      u.value = u.value > 0.5 ? 0.0 : 1.0;
      console.log('[viewer] wind sway ->', u.value > 0.5 ? 'on' : 'off');
    }
  }

  // Toggle size attenuation (distance-based point sizing)
  if (e.key === 'a') {
    const u = points?.material?.uniforms?.uSizeAttenEnabled;
    if (u) {
      u.value = u.value > 0.5 ? 0.0 : 1.0;
      console.log('[viewer] size attenuation ->', u.value > 0.5 ? 'on' : 'off');
    }
  }

  // Toggle world-size points (projection-based pixel size from world units)
  if (e.key === 'w') {
    const u = points?.material?.uniforms;
    if (u && u.uUseWorldSize) {
      u.uUseWorldSize.value = u.uUseWorldSize.value > 0.5 ? 0.0 : 1.0;
      // When enabling, choose world size to match current target pixel size at ref dist
      if (u.uUseWorldSize.value > 0.5) {
        const pxPerUnit = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
        const refDist = u.uSizeAttenRef.value || camera.position.distanceTo(controls.target);
        u.uPxPerUnit.value = pxPerUnit;
        u.uWorldSize.value = Math.max(1e-5, pointSizePx * refDist / pxPerUnit);
      }
      console.log('[viewer] world-size points ->', u.uUseWorldSize.value > 0.5 ? 'on' : 'off');
    }
  }

  // (removed) static size toggle
});

/* ---------------- Animate (advance uTime) ---------------- */
function animate() {
  requestAnimationFrame(animate);
  controls.update();

  // drive the pulse time
  if (points && points.material && points.material.uniforms) {
    points.material.uniforms.uTime.value = performance.now() * 0.001; // seconds
  }

  if (composer) composer.render(); else renderer.render(scene, camera);
}
animate();

/* ---------------- Resize ---------------- */
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  updatePostSizes();

  // keep shader DPR in sync if devicePixelRatio changes
  if (points && points.material && points.material.uniforms) {
    points.material.uniforms.uDPR.value = Math.min(devicePixelRatio, 1.5);
    // update pixels-per-unit for world-size sizing
    points.material.uniforms.uPxPerUnit.value = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
  }
});

/* ---------------- Post FX Hotkeys ----------------
   b: toggle bloom | n/m: bloom strength -/+
   v: toggle vignette | g/h: darkness -/+
   c: toggle brightness/contrast | ,/.: contrast -/+ | ;/': brightness -/+
   y: toggle hue/saturation | u/j: saturation +/- | i/k: hue +/-
   x: toggle FXAA
-------------------------------------------------- */
addEventListener('keydown', (e) => {
  if (!composer) return;
  const k = e.key;

  // Bloom toggle/intensity
  if (k === 'b') {
    bloomPass.enabled = !bloomPass.enabled;
    console.log('[post] bloom ->', bloomPass.enabled);
  }
  if (k === 'n') { // down
    bloomPass.strength = Math.max(0.0, (bloomPass.strength ?? 0.6) - 0.05);
    console.log('[post] bloom strength ->', bloomPass.strength.toFixed(2));
  }
  if (k === 'm') { // up
    bloomPass.strength = Math.min(3.0, (bloomPass.strength ?? 0.6) + 0.05);
    console.log('[post] bloom strength ->', bloomPass.strength.toFixed(2));
  }

  // Vignette toggle/darkness
  if (k === 'v') {
    vignettePass.enabled = !vignettePass.enabled;
    console.log('[post] vignette ->', vignettePass.enabled);
  }
  if (k === 'g') { // darker -
    const d = vignettePass.material.uniforms.darkness;
    d.value = Math.max(0.0, d.value - 0.05);
    console.log('[post] vignette darkness ->', d.value.toFixed(2));
  }
  if (k === 'h') { // darker +
    const d = vignettePass.material.uniforms.darkness;
    d.value = Math.min(2.0, d.value + 0.05);
    console.log('[post] vignette darkness ->', d.value.toFixed(2));
  }

  // Brightness/Contrast toggle and adjust
  if (k === 'c') {
    bcPass.enabled = !bcPass.enabled;
    console.log('[post] brightness/contrast ->', bcPass.enabled);
  }
  if (k === ',') { // contrast -
    const u = bcPass.material.uniforms.contrast;
    u.value = Math.max(-1.0, u.value - 0.05);
    console.log('[post] contrast ->', u.value.toFixed(2));
  }
  if (k === '.') { // contrast +
    const u = bcPass.material.uniforms.contrast;
    u.value = Math.min(1.0, u.value + 0.05);
    console.log('[post] contrast ->', u.value.toFixed(2));
  }
  if (k === ';') { // brightness -
    const u = bcPass.material.uniforms.brightness;
    u.value = Math.max(-1.0, u.value - 0.05);
    console.log('[post] brightness ->', u.value.toFixed(2));
  }
  if (k === "'") { // brightness +
    const u = bcPass.material.uniforms.brightness;
    u.value = Math.min(1.0, u.value + 0.05);
    console.log('[post] brightness ->', u.value.toFixed(2));
  }

  // Hue/Saturation toggle and adjust
  if (k === 'y') {
    hsPass.enabled = !hsPass.enabled;
    console.log('[post] hue/saturation ->', hsPass.enabled);
  }
  if (k === 'u') { // saturation +
    const uSat = hsPass.material.uniforms.saturation;
    uSat.value = Math.min(1.0, uSat.value + 0.05);
    console.log('[post] saturation ->', uSat.value.toFixed(2));
  }
  if (k === 'j') { // saturation -
    const uSat = hsPass.material.uniforms.saturation;
    uSat.value = Math.max(-1.0, uSat.value - 0.05);
    console.log('[post] saturation ->', uSat.value.toFixed(2));
  }
  if (k === 'i') { // hue +
    const uHue = hsPass.material.uniforms.hue;
    uHue.value = Math.min(1.0, uHue.value + 0.02);
    console.log('[post] hue ->', uHue.value.toFixed(2));
  }
  if (k === 'k') { // hue -
    const uHue = hsPass.material.uniforms.hue;
    uHue.value = Math.max(-1.0, uHue.value - 0.02);
    console.log('[post] hue ->', uHue.value.toFixed(2));
  }

  // FXAA toggle
  if (k === 'x') {
    fxaaPass.enabled = !fxaaPass.enabled;
    console.log('[post] FXAA ->', fxaaPass.enabled);
  }
});

// Initialize UI after the module-level lets are initialized
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupUI, { once: true });
} else {
  setupUI();
}
