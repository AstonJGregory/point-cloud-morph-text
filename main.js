// main.js (glowing pulse version)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LUTPass } from 'three/addons/postprocessing/LUTPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { BrightnessContrastShader } from 'three/addons/shaders/BrightnessContrastShader.js';
import { HueSaturationShader } from 'three/addons/shaders/HueSaturationShader.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { LUTCubeLoader } from 'three/addons/loaders/LUTCubeLoader.js';

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
let composer, renderPass, fxaaPass, bcPass, hsPass, vignettePass, bloomPass, edgeBlurPass, lutPass;
const lutLoader = new LUTCubeLoader();
const LUT_PRESETS = {
  warm: { label: 'Warm Glow', path: 'luts/warm.cube' },
  green: { label: 'Green Lift', path: 'luts/LUT_green.cube' },
  mutedUrban: { label: 'Muted Urban', path: 'luts/LUT_muted-urban.cube' },
  forest: { label: 'Forest Boost', path: 'luts/LUT_forest.cube' },
  latest: { label: 'Latest LUT', path: 'luts/LUT_PRESETSSTORE.cube' },
};
let activeLutKey = 'none';
let lutLoadMap = new Map(); // cache of loaded LUT textures
let lutIntensity = 1.0;

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

  lutPass = new LUTPass();
  lutPass.enabled = false;
  lutPass.intensity = 1.0;
  composer.addPass(lutPass);

  updatePostSizes();

  updateLutPass();
}

function updateLutPass() {
  if (!lutPass) return;
  lutPass.intensity = lutIntensity;
  const enabled = activeLutKey !== 'none' && lutPass.lut && lutIntensity > 0.0;
  lutPass.enabled = enabled;
}

function setLutPreset(key) {
  if (!lutPass) {
    activeLutKey = key;
    return;
  }

  const normalized = LUT_PRESETS[key] ? key : 'none';
  activeLutKey = normalized;

  if (normalized === 'none') {
    lutPass.lut = null;
    updateLutPass();
    return;
  }

  const preset = LUT_PRESETS[normalized];
  const { path } = preset;
  const cached = lutLoadMap.get(path);
  if (cached) {
    lutPass.lut = cached;
    updateLutPass();
    return;
  }

  lutLoader.load(
    path,
    (result) => {
      const tex = result.texture3D;
      lutLoadMap.set(path, tex);
      if (activeLutKey === normalized) {
        lutPass.lut = tex;
        updateLutPass();
      }
    },
    undefined,
    (err) => {
      console.error('[LUT] failed to load', path, err);
      if (activeLutKey === normalized) {
        activeLutKey = 'none';
        lutPass.lut = null;
        updateLutPass();
        try { window.dispatchEvent(new Event('ui-refresh')); } catch {}
      }
    }
  );
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
      if (u.uSquareMix) squareMix = u.uSquareMix.value ?? squareMix;
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
controls.enableZoom = false;
renderer.domElement.addEventListener('wheel', handleWheelForMorph, { passive: false });

/* ---------------- Helpers (optional) ---------------- */
scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const grid = new THREE.GridHelper(10, 10);
grid.material.transparent = true;
grid.material.opacity = 0.12;
scene.add(grid);
grid.visible = false;

/* ---------------- Background Text ---------------- */
const BG_TEXT_OFFSET = 1.6; // distance behind the model, along the view axis
const BG_TEXT_VIEWPORT_FRACTION = 0.78; // portion of the view width to cover
const BG_TEXT_CANVAS_WIDTH = 2048;
const BG_TEXT_CANVAS_HEIGHT = 1024;
const BG_TEXT_BASE_FONT_SIZE = 360;
const BG_TEXT_MIN_FONT_SIZE = 80;
const BG_TEXT_MAX_WIDTH_RATIO = 0.88;
const BG_TEXT_FONT_FAMILY = 'Helvetica, "Helvetica Neue", Arial, sans-serif';
let bgTextFill = '#ffffff';

let bgTextLabel = 'POINT CLOUDS';
let bgTextMesh = null;
let bgTextAspect = BG_TEXT_CANVAS_WIDTH / BG_TEXT_CANVAS_HEIGHT;
let bgTextCanvas = null;
let bgTextCtx = null;
let bgTextTexture = null;
const _bgTempDir = new THREE.Vector3();

function updateBackgroundTextTexture() {
  if (!bgTextCtx || !bgTextCanvas || !bgTextTexture) return;

  const width = bgTextCanvas.width;
  const height = bgTextCanvas.height;
  bgTextCtx.clearRect(0, 0, width, height);

  const label = bgTextLabel.trim();
  const hasLabel = label.length > 0;
  if (bgTextMesh) bgTextMesh.visible = hasLabel;
  if (!hasLabel) {
    bgTextTexture.needsUpdate = true;
    return;
  }

  bgTextCtx.textAlign = 'center';
  bgTextCtx.textBaseline = 'middle';
  const maxWidth = width * BG_TEXT_MAX_WIDTH_RATIO;
  const composeFont = (sizePx) => `900 ${sizePx}px ${BG_TEXT_FONT_FAMILY}`;

  let fontSize = BG_TEXT_BASE_FONT_SIZE;
  bgTextCtx.font = composeFont(fontSize);
  let metrics = bgTextCtx.measureText(label);
  if (metrics.width > maxWidth) {
    const scale = maxWidth / Math.max(metrics.width, 1);
    fontSize = Math.max(BG_TEXT_MIN_FONT_SIZE, fontSize * scale);
    bgTextCtx.font = composeFont(fontSize);
    metrics = bgTextCtx.measureText(label);
  }

  bgTextCtx.fillStyle = bgTextFill || '#ffffff';
  bgTextCtx.fillText(label, width * 0.5, height * 0.5);
  bgTextTexture.needsUpdate = true;
}

function buildBackgroundText() {
  bgTextCanvas = document.createElement('canvas');
  bgTextCanvas.width = BG_TEXT_CANVAS_WIDTH;
  bgTextCanvas.height = BG_TEXT_CANVAS_HEIGHT;
  bgTextCtx = bgTextCanvas.getContext('2d');
  if (!bgTextCtx) {
    console.warn('[background-text] 2D context unavailable');
    return;
  }

  bgTextTexture = new THREE.CanvasTexture(bgTextCanvas);
  bgTextTexture.colorSpace = THREE.SRGBColorSpace;
  bgTextTexture.anisotropy = renderer.capabilities?.getMaxAnisotropy
    ? renderer.capabilities.getMaxAnisotropy()
    : 1;
  bgTextTexture.needsUpdate = true;

  const material = new THREE.MeshBasicMaterial({
    map: bgTextTexture,
    transparent: true,
    depthWrite: false,
  });

  const geometry = new THREE.PlaneGeometry(1, 1);
  bgTextMesh = new THREE.Mesh(geometry, material);
  bgTextMesh.name = 'BackgroundText';
  bgTextAspect = BG_TEXT_CANVAS_WIDTH / BG_TEXT_CANVAS_HEIGHT;
  scene.add(bgTextMesh);
  updateBackgroundTextTexture();
  updateBackgroundTextScale();
  updateBackgroundTextPose();
}

function updateBackgroundTextScale() {
  if (!bgTextMesh) return;
  const target = controls.target;
  const camDist = camera.position.distanceTo(target);
  const planeDist = camDist + BG_TEXT_OFFSET;
  const viewHeight = 2 * planeDist * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const targetWidth = viewHeight * camera.aspect * BG_TEXT_VIEWPORT_FRACTION;
  const targetHeight = targetWidth / bgTextAspect;
  bgTextMesh.scale.set(targetWidth, targetHeight, 1);
}

function updateBackgroundTextPose() {
  if (!bgTextMesh) return;
  const target = controls.target;
  _bgTempDir.subVectors(camera.position, target);
  if (_bgTempDir.lengthSq() < 1e-6) return;
  _bgTempDir.normalize().multiplyScalar(BG_TEXT_OFFSET);
  bgTextMesh.position.copy(target).sub(_bgTempDir);
  bgTextMesh.lookAt(camera.position);
}

buildBackgroundText();

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
  const updateGlowUIState = () => {
    if (el.randomSpeed) el.randomSpeed.disabled = glowMode !== 'random';
  };

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
    scatter: $('ui-scatter'), square: $('ui-square'),
    glowMode: $('ui-glow-mode'),
    randomSpeed: $('ui-random-speed'),
    windEnabled: $('ui-wind-enabled'), windAmp: $('ui-wind-amp'), windFreq: $('ui-wind-freq'), windSpatial: $('ui-wind-spatial'),
    waveLength: $('ui-wave-length'), waveSpeed: $('ui-wave-speed'), waveWidth: $('ui-wave-width'), waveGamma: $('ui-wave-gamma'),
    edgeBlur: $('ui-edgeblur'), edgeBlurAmt: $('ui-edgeblur-amt'),
    fog: $('ui-fog'), fogDensity: $('ui-fog-density'),
    bg: $('ui-bg'),
    bgText: $('ui-bg-text'),
    bgTextColor: $('ui-bg-text-color'),
    bloom: $('ui-bloom'), bloomStrength: $('ui-bloom-strength'), vignette: $('ui-vignette'), vignetteDark: $('ui-vignette-dark'),
    bc: $('ui-bc'), contrast: $('ui-contrast'), bright: $('ui-bright'), hs: $('ui-hs'), sat: $('ui-sat'), hue: $('ui-hue'),
    lut: $('ui-lut'), lutIntensity: $('ui-lut-intensity'),
    fxaa: $('ui-fxaa'),
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
      if (el.square) {
        if (u.uSquareMix) squareMix = u.uSquareMix.value ?? squareMix;
        el.square.value = String(squareMix);
        setVal('ui-square-val', (squareMix * 100).toFixed(0) + '%');
      }
      if (el.glowMode) {
        const mode = (u.uGlowMode?.value ?? (glowMode === 'random' ? 1 : 0)) >= 0.5 ? 'random' : 'wave';
        glowMode = mode;
        el.glowMode.value = mode;
      }
      if (el.randomSpeed && u.uRandomGlowSpeed) {
        const v = u.uRandomGlowSpeed.value ?? randomGlowSpeed;
        randomGlowSpeed = v;
        el.randomSpeed.value = String(v);
        setVal('ui-random-speed-val', v.toFixed(1));
      }
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
    else {
      if (el.square) { el.square.value = String(squareMix); setVal('ui-square-val', (squareMix * 100).toFixed(0) + '%'); }
      if (el.glowMode) {
        el.glowMode.value = glowMode;
      }
      if (el.randomSpeed) {
        el.randomSpeed.value = String(randomGlowSpeed);
        setVal('ui-random-speed-val', randomGlowSpeed.toFixed(1));
      }
    }

    updateGlowUIState();

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
    if (el.bgText) {
      el.bgText.value = bgTextLabel;
    }
    if (el.bgTextColor) {
      el.bgTextColor.value = bgTextFill;
      setVal('ui-bg-text-color-val', (bgTextFill || '').toUpperCase());
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
    if (el.lut) { el.lut.value = activeLutKey; }
    if (el.lutIntensity) {
      el.lutIntensity.value = String(lutIntensity);
      el.lutIntensity.disabled = activeLutKey === 'none';
      setVal('ui-lut-intensity-val', lutIntensity.toFixed(2));
    }
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

  el.square?.addEventListener('input', () => {
    squareMix = Math.max(0, Math.min(1, Number(el.square.value)));
    setVal('ui-square-val', (squareMix * 100).toFixed(0) + '%');
    const u = getU(); if (u?.uSquareMix) u.uSquareMix.value = squareMix;
  });

  el.glowMode?.addEventListener('change', () => {
    glowMode = el.glowMode.value === 'random' ? 'random' : 'wave';
    const u = getU();
    if (u?.uGlowMode) u.uGlowMode.value = glowMode === 'random' ? 1.0 : 0.0;
    if (el.randomSpeed) {
      el.randomSpeed.value = String(randomGlowSpeed);
      setVal('ui-random-speed-val', randomGlowSpeed.toFixed(1));
    }
    updateGlowUIState();
  });

  el.randomSpeed?.addEventListener('input', () => {
    randomGlowSpeed = Math.max(0.1, Math.min(5, Number(el.randomSpeed.value)));
    setVal('ui-random-speed-val', randomGlowSpeed.toFixed(1));
    const u = getU();
    if (u?.uRandomGlowSpeed) u.uRandomGlowSpeed.value = randomGlowSpeed;
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
  el.bgText?.addEventListener('input', () => {
    bgTextLabel = el.bgText.value ?? '';
    updateBackgroundTextTexture();
  });
  el.bgTextColor?.addEventListener('input', () => {
    bgTextFill = el.bgTextColor.value || '#ffffff';
    setVal('ui-bg-text-color-val', (bgTextFill || '').toUpperCase());
    updateBackgroundTextTexture();
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
  el.lut?.addEventListener('change', () => {
    setLutPreset(el.lut.value);
    refreshUI();
  });
  el.lutIntensity?.addEventListener('input', () => {
    lutIntensity = Math.max(0.0, Math.min(1.0, Number(el.lutIntensity.value)));
    setVal('ui-lut-intensity-val', lutIntensity.toFixed(2));
    updateLutPass();
  });
  el.fxaa?.addEventListener('change', () => { if (fxaaPass) fxaaPass.enabled = el.fxaa.checked; });

  // Initial sync
  refreshUI();

  // Note: event handlers that call buildPoints also call refreshUI()
}

// (moved) UI initialization happens later after key vars are defined

/* ---------------- Utilities ---------------- */
// Sample a geometry down to a specific point count, returning raw arrays.
function sampleGeometryAttributes(sourceGeom, targetCount) {
  if (!sourceGeom || !targetCount) return null;
  const pos = sourceGeom.getAttribute('position');
  if (!pos) return null;

  const srcCount = pos.count;
  const count = Math.max(1, Math.min(targetCount, srcCount));

  const colorAttr = sourceGeom.getAttribute('color');
  const positions = new Float32Array(count * 3);
  const colors = colorAttr ? new Float32Array(count * 3) : null;

  const step = srcCount / count;
  let idx = 0;
  for (let i = 0; i < count; i++) {
    const srcIndex = Math.min(srcCount - 1, Math.floor(idx));
    positions[i * 3 + 0] = pos.getX(srcIndex);
    positions[i * 3 + 1] = pos.getY(srcIndex);
    positions[i * 3 + 2] = pos.getZ(srcIndex);
    if (colors && colorAttr) {
      colors[i * 3 + 0] = colorAttr.getX(srcIndex);
      colors[i * 3 + 1] = colorAttr.getY(srcIndex);
      colors[i * 3 + 2] = colorAttr.getZ(srcIndex);
    }
    idx += step;
  }

  return { count, positions, colors };
}

function prepareGeometryForView(geom) {
  if (!geom) return null;
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (!bb) return geom;

  const cx = (bb.min.x + bb.max.x) * 0.5;
  const cy = (bb.min.y + bb.max.y) * 0.5;
  const cz = (bb.min.z + bb.max.z) * 0.5;
  geom.translate(-cx, -cy, -cz);

  const maxDim = Math.max(
    bb.max.x - bb.min.x,
    bb.max.y - bb.min.y,
    bb.max.z - bb.min.z
  ) || 1;
  const scale = 2 / maxDim;
  geom.scale(scale, scale, scale);

  geom.rotateY(THREE.MathUtils.degToRad(30));
  geom.computeBoundingBox();
  geom.computeBoundingSphere?.();
  return geom;
}

function updateMorphUniform() {
  const u = points?.material?.uniforms?.uMorph;
  if (u) u.value = morphAmount;
}

function setMorphAmount(value) {
  morphAmount = THREE.MathUtils.clamp(value, 0.0, 1.0);
  updateMorphUniform();
}

function syncMorphToScroll() {
  const doc = document.documentElement;
  const body = document.body;
  const scrollTop = window.scrollY || doc?.scrollTop || body?.scrollTop || 0;
  const scrollHeight = Math.max(
    doc?.scrollHeight ?? 0,
    body?.scrollHeight ?? 0
  );
  const maxScroll = Math.max(0, scrollHeight - window.innerHeight);
  const ratio = maxScroll > 0 ? scrollTop / maxScroll : 0;
  setMorphAmount(ratio);
}

function handleWheelForMorph(event) {
  if (!allowWheelMorph) return;
  const panel = document.getElementById('ui-panel');
  const toggle = document.getElementById('ui-toggle');
  if ((panel && panel.contains(event.target)) || (toggle && toggle.contains(event.target))) return; // allow UI scrolling
  if (event.target && typeof event.target.closest === 'function') {
    if (event.target.closest('input, select, textarea')) return;
  }
  if (event.altKey || event.ctrlKey || event.metaKey) return; // let modifier + wheel pass through for zooming

  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === 'function') {
    event.stopImmediatePropagation();
  }

  const delta = event.deltaY || 0;
  if (!delta) return;
  const mode = event.deltaMode || 0;
  const baseStep = mode === 1 ? 0.04 : mode === 2 ? 1.0 : 0.0007;
  const step = event.shiftKey ? baseStep * 3.0 : baseStep;
  const next = morphAmount + delta * step;
  setMorphAmount(next);
}

function loadMorphTargetGeometry(path) {
  morphTargetGeom = null;
  if (!path) {
    allowWheelMorph = false;
    setMorphAmount(0);
    return;
  }

  loader.load(
    path,
    (geom) => {
      morphTargetGeom = prepareGeometryForView(geom);
      allowWheelMorph = true;
      syncMorphToScroll();
      buildPoints();
      console.log('[PLY] morph target ready:', path);
    },
    undefined,
    (err) => {
      console.error('PLY morph target load error:', err);
      morphTargetGeom = null;
      allowWheelMorph = false;
      setMorphAmount(0);
    }
  );
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
    uMorph:       { value: 0.0 },        // 0=start, 1=target
    uGlowMode:    { value: glowMode === 'random' ? 1.0 : 0.0 },
    uRandomGlowSpeed: { value: randomGlowSpeed },

    // Size attenuation (0 = off, 1 = on). Ref distance where size is unchanged.
    uSizeAttenEnabled: { value: 0.0 },
    uSizeAttenRef:     { value: 2.0 },

    // World-size points (true world units → pixels via projection)
    uUseWorldSize: { value: 1.0 },  // default ON for this experiment
    uWorldSize:    { value: 0.015 }, // diameter in world units
    uPxPerUnit:    { value: 1.0 },   // pixels per world unit (CSS px)
    // Random scatter amount (world units)
    uScatterAmp:   { value: scatterAmp },
    uSquareMix:    { value: squareMix },

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
    uniform float uGlowMode;
    uniform float uRandomGlowSpeed;
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
    attribute vec3 morphPosition;
    attribute vec3 morphColor;
    uniform float uMorph;
    // Wind uniforms
    uniform vec3  uWindDir;
    uniform float uWindAmp;
    uniform float uWindFreq;
    uniform float uWindSpatial;
    uniform float uWindEnabled;
    varying vec3  vColor;
    varying float vPulse;
    varying float vViewZ;
    varying float vHash;

    void main() {
      float morph = clamp(uMorph, 0.0, 1.0);
      vec3 p0 = position;
      vec3 p1 = morphPosition;
      vec3 p = mix(p0, p1, morph);

      // Height factor (0 at base, 1 at top). Model is roughly in [-1,1] Y.
      float h = clamp(p.y * 0.5 + 0.5, 0.0, 1.0);

      // Stable random direction per point; displace by uScatterAmp
      vec3 noiseSeed = p0 + p1;
      float h1 = fract(sin(dot(noiseSeed.xyz, vec3(127.1, 311.7,  74.7))) * 43758.5453);
      float h2 = fract(sin(dot(noiseSeed.yzx, vec3(269.5, 183.3, 246.1))) * 43758.5453);
      float h3 = fract(sin(dot(noiseSeed.zxy, vec3(113.5, 271.9, 124.6))) * 43758.5453);
      vec3 randDir = normalize(vec3(h1 * 2.0 - 1.0, h2 * 2.0 - 1.0, h3 * 2.0 - 1.0) + 1e-4);
      p += randDir * uScatterAmp;

      // Pseudo-random per-point phase for variation
      float hash = fract(sin(dot(noiseSeed.xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      vHash = hash;

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
      float wavePulse = pow(band, uBandGamma);

      float randomPhase = uTime * uRandomGlowSpeed + hash * 6.2831853;
      float flicker = clamp(0.5 + 0.5 * sin(randomPhase), 0.0, 1.0);
      float randomPulse = pow(flicker, 3.0);

      float modeMix = clamp(uGlowMode, 0.0, 1.0);
      vPulse = mix(wavePulse, randomPulse, modeMix);

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
      vColor = mix(color, morphColor, morph); // (0,0,0) if no vertex colors bound
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
uniform float uSquareMix;
uniform float uFogEnabled;
uniform float uFogDensity;
uniform vec3  uFogColor;

varying vec3  vColor;
varying float vPulse;
varying float vViewZ;
varying float vHash;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float squareMask = step(1.0 - uSquareMix, vHash);
  float r2 = dot(uv, uv);
  if (squareMask < 0.5 && r2 > 1.0) discard;

  float alpha = 1.0;
  if (squareMask >= 0.5) {
    float edge = max(abs(uv.x), abs(uv.y));
    alpha = clamp(1.0 - smoothstep(0.96, 1.0, edge), 0.0, 1.0);
    if (alpha <= 0.0) discard;
  }

  vec3 base = mix(uColor, vColor, uUseVertexColor);
  vec3 col  = base * (1.0 + uGlowBoost * vPulse);

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
    depthWrite: true,
    blending: THREE.NormalBlending,
  });
}

/* ---------------- Load PLY & Build Points ---------------- */
const loader = new PLYLoader();

let originalGeom = null; // unmodified, for re-subsampling
let points = null;       // THREE.Points instance

const MORPH_PAIRS = {
  'point/tree-bush.ply': 'point/tree-stump-2.ply',
};
let morphTargetGeom = null;
let morphAmount = 0.0;
let allowWheelMorph = false;

let keepRatio = 0.18;    // ↓ fewer points for speed (try 0.10–0.25)
let pointSizePx = 3.0;   // ↑ base point size (pixels)
let useScreenSize = true; // kept for API parity; shader uses screen-space size
let scatterAmp = 0.0;    // random displacement amplitude (world units)
let glowMode = 'wave';   // 'wave' or 'random'
let randomGlowSpeed = 1.2; // Hz for random flicker
let squareMix = 0.0;     // 0 = circles, 1 = all squares


function buildPoints() {
  if (!originalGeom) return;

  const basePos = originalGeom.getAttribute('position');
  if (!basePos) return;

  const baseCount = basePos.count;
  const baseTarget = Math.max(1, Math.floor(baseCount * keepRatio));

  let finalCount = baseTarget;
  const morphPos = morphTargetGeom?.getAttribute?.('position');
  if (morphPos) {
    const morphTarget = Math.max(1, Math.floor(morphPos.count * keepRatio));
    finalCount = Math.min(baseTarget, morphTarget);
  }

  const baseSample = sampleGeometryAttributes(originalGeom, finalCount);
  if (!baseSample) return;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(baseSample.positions, 3));

  const baseColorsArray = baseSample.colors ?? (() => {
    const arr = new Float32Array(baseSample.count * 3);
    arr.fill(1);
    return arr;
  })();
  geom.setAttribute('color', new THREE.BufferAttribute(baseColorsArray, 3));
  const hasColor = !!baseSample.colors;

  let morphPositionArray = null;
  let morphColorArray = null;
  if (morphPos) {
    const targetSample = sampleGeometryAttributes(morphTargetGeom, finalCount);
    if (targetSample) {
      morphPositionArray = targetSample.positions ?? baseSample.positions.slice();
      morphColorArray = targetSample.colors ?? null;
    }
  }

  if (!morphPositionArray) {
    morphPositionArray = baseSample.positions.slice();
  }
  if (!morphColorArray) {
    if (baseSample.colors) {
      morphColorArray = baseSample.colors.slice();
    } else {
      morphColorArray = new Float32Array(baseSample.count * 3);
      morphColorArray.fill(1);
    }
  }

  geom.setAttribute('morphPosition', new THREE.BufferAttribute(morphPositionArray, 3));
  geom.setAttribute('morphColor', new THREE.BufferAttribute(morphColorArray, 3));
  geom.computeBoundingBox();

  const mat = makeGlowMaterial(hasColor, pointSizePx);
  if (mat?.uniforms?.uSquareMix) mat.uniforms.uSquareMix.value = squareMix;
  if (mat?.uniforms?.uMorph) mat.uniforms.uMorph.value = morphAmount;

  if (points) {
    points.geometry.dispose();
    points.material.dispose();
    scene.remove(points);
  }

  points = new THREE.Points(geom, mat);
  points.frustumCulled = true;
  scene.add(points);

  const u = points.material.uniforms;
  if (u) {
    const pxPerUnit = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)));
    u.uPxPerUnit.value = pxPerUnit;
    if (u.uUseWorldSize.value > 0.5) {
      const refDist = camera.position.distanceTo(controls.target);
      u.uWorldSize.value = Math.max(1e-5, pointSizePx * refDist / pxPerUnit);
    }
  }

  updateFog();
}

// Available models and current index
const models = [
  'point/tree-bush.ply',
  'point/tree-stump-2.ply',
];
let modelIndex = 0;

function loadModel(path) {
  console.log('[PLY] loading:', path);
  loader.load(
    path,
    (geom) => {
      originalGeom = prepareGeometryForView(geom);
      setMorphAmount(0);
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

      const targetPath = MORPH_PAIRS[path] ?? null;
      loadMorphTargetGeometry(targetPath);
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
  updateBackgroundTextPose();

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
  updateBackgroundTextScale();
  updateBackgroundTextPose();
  syncMorphToScroll();
});

addEventListener('scroll', syncMorphToScroll, { passive: true });
syncMorphToScroll();

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
