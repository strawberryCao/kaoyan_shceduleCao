import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const BACKGROUND_VERTEX = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BACKGROUND_FRAGMENT = `
precision highp float;

uniform sampler2D uTexture;
uniform vec2 uMouse;
uniform float uTime;
uniform float uTextureReady;
varying vec2 vUv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amp * noise(p);
    p *= 2.02;
    amp *= 0.52;
  }
  return value;
}

void main() {
  vec2 uv = vUv;
  vec2 mouse = uMouse - 0.5;
  float flow = fbm(uv * 2.4 + vec2(uTime * 0.018, -uTime * 0.012));
  vec2 offset = mouse * 0.010 + (flow - 0.5) * 0.004;
  vec3 tex = texture2D(uTexture, clamp(uv + offset, 0.0, 1.0)).rgb;
  vec3 fallback = mix(vec3(0.90, 0.84, 0.74), vec3(0.54, 0.50, 0.46), smoothstep(0.25, 1.15, uv.x + uv.y * 0.35));
  vec3 color = mix(fallback, tex, uTextureReady);

  float grain = hash(floor(uv * vec2(720.0, 420.0)) + uTime * 0.02);
  color += (grain - 0.5) * 0.018;

  float light = smoothstep(0.82, 0.0, length((uv - vec2(0.17, 0.18)) * vec2(0.9, 1.15)));
  color += vec3(1.0, 0.83, 0.55) * light * (0.035 + sin(uTime * 0.25) * 0.01);

  float vignette = smoothstep(0.92, 0.32, length((uv - 0.5) * vec2(0.92, 1.12)));
  color *= 0.78 + vignette * 0.26;
  gl_FragColor = vec4(color, 1.0);
}
`;

const SILK_VERTEX = `
uniform float uTime;
uniform vec2 uMouse;
uniform vec2 uWind;
uniform float uPhase;
uniform float uWaveStrength;
varying vec2 vUv;
varying float vFold;

void main() {
  vUv = uv;
  vec3 nextPosition = position;
  float waveA = sin(position.x * 2.4 + uTime * 0.62 + uPhase);
  float waveB = sin(position.x * 5.7 - uTime * 0.38 + uPhase * 1.7);
  float waveC = sin((position.x + position.y) * 3.1 + uTime * 0.48 + uPhase * 0.5);
  float mouseInfluence = smoothstep(1.3, 0.0, length(vec2(position.x * 0.28, position.y * 0.55) - (uMouse - 0.5) * vec2(6.0, 3.0)));
  float windPower = clamp(length(uWind) * 18.0, 0.0, 1.0);
  float fold = waveA * 0.55 + waveB * 0.28 + waveC * 0.18;
  nextPosition.z += fold * uWaveStrength;
  nextPosition.y += waveB * 0.065 * uWaveStrength + mouseInfluence * windPower * 0.18;
  nextPosition.x += uWind.x * mouseInfluence * 0.55;
  vFold = fold * 0.5 + 0.5;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(nextPosition, 1.0);
}
`;

const SILK_FRAGMENT = `
precision highp float;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
uniform float uTime;
varying vec2 vUv;
varying float vFold;

float band(float center, float width) {
  return smoothstep(width, 0.0, abs(vUv.y - center));
}

void main() {
  float edgeFade = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x) * smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.12, 1.0 - vUv.y);
  float fiber = 0.5 + 0.5 * sin((vUv.x + vUv.y) * 94.0 + uTime * 0.42);
  float ribbon = band(0.50 + sin(vUv.x * 7.0 + uTime * 0.18) * 0.08, 0.44);
  float shine = pow(max(vFold, 0.0), 2.2) * 0.72 + fiber * 0.12;
  vec3 color = mix(uColorA, uColorB, vUv.x * 0.65 + shine * 0.35);
  color += vec3(1.0, 0.91, 0.72) * shine * 0.18;
  float alpha = uOpacity * edgeFade * ribbon * (0.55 + shine * 0.45);
  gl_FragColor = vec4(color, alpha);
}
`;

const PARTICLE_VERTEX = `
attribute float aSize;
attribute float aSeed;
uniform float uTime;
uniform float uPixelRatio;
varying float vSeed;

void main() {
  vSeed = aSeed;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPixelRatio * (220.0 / -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const PARTICLE_FRAGMENT = `
precision highp float;
varying float vSeed;

void main() {
  vec2 point = gl_PointCoord - 0.5;
  float d = length(point);
  float alpha = smoothstep(0.5, 0.0, d) * (0.38 + vSeed * 0.48);
  vec3 color = mix(vec3(0.92, 0.72, 0.42), vec3(1.0, 0.92, 0.72), vSeed);
  gl_FragColor = vec4(color, alpha);
}
`;

type ParticleState = {
  positions: Float32Array;
  velocities: Float32Array;
  seeds: Float32Array;
  count: number;
};

const createFallbackTexture = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 64, 64);
    gradient.addColorStop(0, '#f3ead8');
    gradient.addColorStop(0.52, '#c9b493');
    gradient.addColorStop(1, '#58524b');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

const createParticleState = (count: number): ParticleState => {
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const i = index * 3;
    positions[i] = THREE.MathUtils.randFloatSpread(9.5);
    positions[i + 1] = THREE.MathUtils.randFloatSpread(5.2) - 0.3;
    positions[i + 2] = THREE.MathUtils.randFloat(-2.2, 1.8);
    velocities[i] = THREE.MathUtils.randFloat(0.018, 0.052);
    velocities[i + 1] = THREE.MathUtils.randFloat(-0.003, 0.018);
    velocities[i + 2] = THREE.MathUtils.randFloat(-0.004, 0.004);
    seeds[index] = Math.random();
  }
  return { positions, velocities, seeds, count };
};

const resetParticle = (state: ParticleState, index: number, leftSide = true) => {
  const i = index * 3;
  state.positions[i] = leftSide ? THREE.MathUtils.randFloat(-5.2, -4.7) : THREE.MathUtils.randFloat(-5.0, 5.0);
  state.positions[i + 1] = THREE.MathUtils.randFloat(-2.8, 2.5);
  state.positions[i + 2] = THREE.MathUtils.randFloat(-2.2, 1.8);
  state.velocities[i] = THREE.MathUtils.randFloat(0.018, 0.052);
  state.velocities[i + 1] = THREE.MathUtils.randFloat(-0.003, 0.018);
  state.velocities[i + 2] = THREE.MathUtils.randFloat(-0.004, 0.004);
};

export function DunhuangBackdrop() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setClearColor(0xe8ddcb, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
    camera.position.set(0, 0, 8.2);

    const pointer = new THREE.Vector2(0, 0);
    const smoothPointer = new THREE.Vector2(0, 0);
    const previousPointer = new THREE.Vector2(0, 0);
    const wind = new THREE.Vector2(0, 0);
    const clock = new THREE.Clock();

    const fallbackTexture = createFallbackTexture();
    const backgroundUniforms = {
      uTexture: { value: fallbackTexture },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
      uTime: { value: 0 },
      uTextureReady: { value: 0 },
    };

    const loader = new THREE.TextureLoader();
    loader.load(
      `/dunhuang-wallpaper.png?ts=${Date.now()}`,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        backgroundUniforms.uTexture.value = texture;
        backgroundUniforms.uTextureReady.value = 1;
      },
      undefined,
      () => {
        backgroundUniforms.uTextureReady.value = 0;
      },
    );

    const backgroundMaterial = new THREE.ShaderMaterial({
      vertexShader: BACKGROUND_VERTEX,
      fragmentShader: BACKGROUND_FRAGMENT,
      uniforms: backgroundUniforms,
      depthWrite: false,
      depthTest: false,
    });
    const background = new THREE.Mesh(new THREE.PlaneGeometry(13.8, 7.8, 1, 1), backgroundMaterial);
    background.position.z = -5.2;
    scene.add(background);

    const silkUniformsA = {
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
      uWind: { value: new THREE.Vector2(0, 0) },
      uPhase: { value: 0.3 },
      uWaveStrength: { value: 0.34 },
      uColorA: { value: new THREE.Color('#f7dfaa') },
      uColorB: { value: new THREE.Color('#fff4d8') },
      uOpacity: { value: 0.30 },
    };
    const silkUniformsB = {
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
      uWind: { value: new THREE.Vector2(0, 0) },
      uPhase: { value: 2.9 },
      uWaveStrength: { value: 0.24 },
      uColorA: { value: new THREE.Color('#dcc196') },
      uColorB: { value: new THREE.Color('#fff8e8') },
      uOpacity: { value: 0.18 },
    };

    const createSilk = (uniforms: typeof silkUniformsA, width: number, height: number, x: number, y: number, z: number, rotation: number) => {
      const geometry = new THREE.PlaneGeometry(width, height, 96, 18);
      const material = new THREE.ShaderMaterial({
        vertexShader: SILK_VERTEX,
        fragmentShader: SILK_FRAGMENT,
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.rotation.z = rotation;
      scene.add(mesh);
      return mesh;
    };

    const silkA = createSilk(silkUniformsA, 9.7, 1.35, -1.08, -0.18, -2.8, -0.18);
    const silkB = createSilk(silkUniformsB, 6.6, 1.02, 1.72, 1.10, -2.2, 0.42);

    const particleState = createParticleState(560);
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(particleState.positions, 3));
    particleGeometry.setAttribute('aSeed', new THREE.BufferAttribute(particleState.seeds, 1));
    const sizes = new Float32Array(particleState.count);
    for (let index = 0; index < particleState.count; index += 1) {
      sizes[index] = THREE.MathUtils.randFloat(4.0, 11.5);
    }
    particleGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    const particleMaterial = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 1.75) },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const particles = new THREE.Points(particleGeometry, particleMaterial);
    particles.position.z = -1.25;
    scene.add(particles);

    const resize = () => {
      const width = Math.max(1, window.innerWidth);
      const height = Math.max(1, window.innerHeight);
      renderer.setSize(width, height, false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      particleMaterial.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 1.75);
    };

    const onPointerMove = (event: PointerEvent) => {
      const width = Math.max(1, window.innerWidth);
      const height = Math.max(1, window.innerHeight);
      pointer.x = event.clientX / width;
      pointer.y = 1 - event.clientY / height;
      document.documentElement.style.setProperty('--dh-x', `${(pointer.x - 0.5) * 18}px`);
      document.documentElement.style.setProperty('--dh-y', `${(0.5 - pointer.y) * 14}px`);
    };

    let animationId = 0;
    const animate = () => {
      const elapsed = clock.getElapsedTime();
      previousPointer.copy(smoothPointer);
      smoothPointer.lerp(pointer, 0.075);
      wind.multiplyScalar(0.90).add(smoothPointer.clone().sub(previousPointer).multiplyScalar(3.2));

      backgroundUniforms.uTime.value = elapsed;
      backgroundUniforms.uMouse.value.set(smoothPointer.x, smoothPointer.y);
      silkUniformsA.uTime.value = elapsed;
      silkUniformsB.uTime.value = elapsed * 0.84;
      silkUniformsA.uMouse.value.set(smoothPointer.x, smoothPointer.y);
      silkUniformsB.uMouse.value.set(smoothPointer.x, smoothPointer.y);
      silkUniformsA.uWind.value.set(wind.x, wind.y);
      silkUniformsB.uWind.value.set(wind.x * 0.7, wind.y * 0.7);
      particleMaterial.uniforms.uTime.value = elapsed;

      silkA.position.x = -1.08 + (smoothPointer.x - 0.5) * 0.12;
      silkA.position.y = -0.18 + (smoothPointer.y - 0.5) * 0.08;
      silkB.position.x = 1.72 - (smoothPointer.x - 0.5) * 0.10;
      silkB.position.y = 1.10 + (smoothPointer.y - 0.5) * 0.06;

      const mouseWorldX = (smoothPointer.x - 0.5) * 9.5;
      const mouseWorldY = (smoothPointer.y - 0.5) * 5.3;
      const windPower = Math.min(1.0, wind.length() * 20.0);
      for (let index = 0; index < particleState.count; index += 1) {
        const i = index * 3;
        const dx = particleState.positions[i] - mouseWorldX;
        const dy = particleState.positions[i + 1] - mouseWorldY;
        const influence = Math.exp(-(dx * dx * 0.24 + dy * dy * 0.72)) * windPower;
        particleState.velocities[i] += wind.x * influence * 0.055 + 0.0009;
        particleState.velocities[i + 1] += wind.y * influence * 0.050 + Math.sin(elapsed * 0.8 + particleState.seeds[index] * 8.0) * 0.0008;
        particleState.velocities[i] *= 0.992;
        particleState.velocities[i + 1] *= 0.988;
        particleState.positions[i] += particleState.velocities[i];
        particleState.positions[i + 1] += particleState.velocities[i + 1];
        particleState.positions[i + 2] += Math.sin(elapsed * 0.25 + particleState.seeds[index] * 9.0) * 0.0012;
        if (particleState.positions[i] > 5.3 || particleState.positions[i + 1] > 3.1 || particleState.positions[i + 1] < -3.1) {
          resetParticle(particleState, index, true);
        }
      }
      particleGeometry.attributes.position.needsUpdate = true;

      renderer.render(scene, camera);
      animationId = window.requestAnimationFrame(animate);
    };

    resize();
    animate();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    return () => {
      window.cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      background.geometry.dispose();
      backgroundMaterial.dispose();
      silkA.geometry.dispose();
      (silkA.material as THREE.Material).dispose();
      silkB.geometry.dispose();
      (silkB.material as THREE.Material).dispose();
      particleGeometry.dispose();
      particleMaterial.dispose();
      fallbackTexture.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="dh-backdrop" aria-hidden="true">
      <div className="dh-sandscape" />
      <div ref={mountRef} className="dh-three-mount" />
      <div className="dh-vignette" />
    </div>
  );
}
