import { useEffect, useRef } from 'react';

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform vec2 u_imageResolution;
uniform vec2 u_mouse;
uniform vec2 u_wind;
uniform float u_time;
uniform float u_imageReady;

varying vec2 v_uv;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    value += amp * noise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return value;
}

vec2 coverUv(vec2 uv) {
  vec2 safeImage = max(u_imageResolution, vec2(1.0));
  float screenRatio = u_resolution.x / max(u_resolution.y, 1.0);
  float imageRatio = safeImage.x / safeImage.y;
  vec2 nextUv = uv;
  if (screenRatio > imageRatio) {
    float scale = imageRatio / screenRatio;
    nextUv.y = uv.y * scale + (1.0 - scale) * 0.5;
  } else {
    float scale = screenRatio / imageRatio;
    nextUv.x = uv.x * scale + (1.0 - scale) * 0.5;
  }
  return nextUv;
}

float ribbonMask(vec2 uv, float offset, float width, float speed, float phase) {
  float curve = offset
    + sin(uv.x * 5.2 + u_time * speed + phase) * 0.035
    + sin(uv.x * 11.0 - u_time * speed * 0.72 + phase) * 0.012;
  float dist = abs(uv.y - curve);
  float body = smoothstep(width, 0.0, dist);
  float edge = smoothstep(width * 0.36, 0.0, dist) * 0.72;
  float weave = 0.55 + 0.45 * sin((uv.x + uv.y) * 68.0 + u_time * 0.85 + phase);
  return body * (0.38 + edge * 0.62) * (0.74 + weave * 0.18);
}

float sandGrain(vec2 uv) {
  vec2 grid = uv * vec2(190.0, 110.0);
  vec2 id = floor(grid);
  vec2 f = fract(grid) - 0.5;
  float rnd = hash(id);
  float sparkle = step(0.965, rnd);
  float d = length(f + vec2(sin(u_time * 0.18 + rnd * 6.283) * 0.12, cos(u_time * 0.12 + rnd * 8.0) * 0.06));
  return sparkle * smoothstep(0.18, 0.0, d) * (0.35 + rnd * 0.65);
}

float windSand(vec2 uv) {
  vec2 mouse = u_mouse;
  vec2 wind = u_wind;
  float windPower = clamp(length(wind) * 18.0, 0.0, 1.0);
  vec2 plumeUv = uv - mouse;
  plumeUv.x -= wind.x * 0.55;
  plumeUv.y += wind.y * 0.35;
  float plumeShape = exp(-dot(plumeUv * vec2(3.0, 5.4), plumeUv * vec2(3.0, 5.4)));
  float dust = fbm(uv * 24.0 - u_time * vec2(0.55, 0.10) - wind * 4.0);
  return plumeShape * windPower * smoothstep(0.46, 0.93, dust);
}

void main() {
  vec2 uv = v_uv;
  vec2 centered = uv - 0.5;
  vec2 mouse = u_mouse - 0.5;
  vec2 wind = u_wind;

  float slowNoise = fbm(uv * 2.2 + vec2(u_time * 0.018, -u_time * 0.012));
  vec2 silkFlow = vec2(
    sin(uv.y * 7.0 + u_time * 0.12) * 0.0022,
    cos(uv.x * 8.0 - u_time * 0.09) * 0.0018
  );
  vec2 mousePull = mouse * 0.010;
  vec2 windRipple = wind * (0.018 * smoothstep(0.0, 0.65, 1.0 - length(uv - u_mouse)));
  vec2 sampleUv = coverUv(uv + silkFlow + mousePull + windRipple + (slowNoise - 0.5) * 0.0035);

  vec3 base = texture2D(u_texture, clamp(sampleUv, 0.0, 1.0)).rgb;
  vec3 fallback = mix(vec3(0.92, 0.86, 0.76), vec3(0.60, 0.55, 0.50), smoothstep(0.45, 1.0, uv.x + uv.y * 0.25));
  base = mix(fallback, base, u_imageReady);

  float r1 = ribbonMask(uv + wind * 0.04, 0.43, 0.115, 0.20, 0.0);
  float r2 = ribbonMask(uv - wind * 0.03, 0.66, 0.075, -0.16, 2.1);
  float r3 = ribbonMask(uv + vec2(0.0, sin(u_time * 0.08) * 0.018), 0.28, 0.055, 0.13, 4.3);
  float silk = r1 * 0.36 + r2 * 0.22 + r3 * 0.16;
  float silkHighlight = pow(max(0.0, silk), 1.55);
  vec3 silkColor = vec3(1.0, 0.88, 0.62);
  base += silkColor * silkHighlight * 0.16;
  base = mix(base, base * vec3(1.04, 0.99, 0.92), silk * 0.12);

  float sand = sandGrain(uv + vec2(u_time * 0.006, -u_time * 0.002));
  float plume = windSand(uv);
  vec3 sandColor = vec3(1.0, 0.78, 0.45);
  base += sandColor * sand * 0.20;
  base += sandColor * plume * 0.34;

  float breath = 0.5 + 0.5 * sin(u_time * 0.22);
  float light = smoothstep(0.92, 0.0, length((uv - vec2(0.17, 0.18)) * vec2(0.92, 1.25)));
  base += vec3(1.0, 0.86, 0.62) * light * (0.035 + breath * 0.022);

  float vignette = smoothstep(0.94, 0.28, length(centered * vec2(0.95, 1.12)));
  base *= 0.78 + vignette * 0.26;
  base = pow(max(base, vec3(0.0)), vec3(0.96));

  gl_FragColor = vec4(base, 1.0);
}
`;

const compileShader = (gl: WebGLRenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Unable to create WebGL shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? 'Unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
};

const createProgram = (gl: WebGLRenderingContext) => {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) {
    throw new Error('Unable to create WebGL program');
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'Unknown WebGL link error';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
};

const createTexture = (gl: WebGLRenderingContext) => {
  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Unable to create WebGL texture');
  }
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([234, 221, 201, 255]));
  return texture;
};

export function DunhuangBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: true,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });

    if (!gl) {
      canvas.classList.add('webgl-unavailable');
      return;
    }

    let animationId = 0;
    let width = 1;
    let height = 1;
    let imageReady = 0;
    let imageWidth = 1920;
    let imageHeight = 1080;
    const targetMouse = { x: 0.5, y: 0.5 };
    const smoothMouse = { x: 0.5, y: 0.5 };
    const previousMouse = { x: 0.5, y: 0.5 };
    const wind = { x: 0, y: 0 };

    let program: WebGLProgram;
    let texture: WebGLTexture;

    try {
      program = createProgram(gl);
      texture = createTexture(gl);
    } catch (error) {
      console.error('[DunhuangBackdrop] WebGL init failed:', error);
      canvas.classList.add('webgl-unavailable');
      return;
    }

    const positionLocation = gl.getAttribLocation(program, 'a_position');
    const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
    const imageResolutionLocation = gl.getUniformLocation(program, 'u_imageResolution');
    const mouseLocation = gl.getUniformLocation(program, 'u_mouse');
    const windLocation = gl.getUniformLocation(program, 'u_wind');
    const timeLocation = gl.getUniformLocation(program, 'u_time');
    const textureLocation = gl.getUniformLocation(program, 'u_texture');
    const imageReadyLocation = gl.getUniformLocation(program, 'u_imageReady');

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const onPointerMove = (event: PointerEvent) => {
      const nextX = event.clientX / Math.max(1, width);
      const nextY = 1 - event.clientY / Math.max(1, height);
      targetMouse.x = Math.min(1, Math.max(0, nextX));
      targetMouse.y = Math.min(1, Math.max(0, nextY));
      document.documentElement.style.setProperty('--dh-x', `${(targetMouse.x - 0.5) * 22}px`);
      document.documentElement.style.setProperty('--dh-y', `${(0.5 - targetMouse.y) * 16}px`);
    };

    const image = new Image();
    image.onload = () => {
      imageWidth = image.naturalWidth || 1920;
      imageHeight = image.naturalHeight || 1080;
      imageReady = 1;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    };
    image.onerror = () => {
      imageReady = 0;
      console.warn('[DunhuangBackdrop] public/dunhuang-wallpaper.png not found, using shader fallback.');
    };
    image.src = `/dunhuang-wallpaper.png?ts=${Date.now()}`;

    const startedAt = performance.now();
    const render = () => {
      const time = (performance.now() - startedAt) / 1000;
      previousMouse.x = smoothMouse.x;
      previousMouse.y = smoothMouse.y;
      smoothMouse.x += (targetMouse.x - smoothMouse.x) * 0.075;
      smoothMouse.y += (targetMouse.y - smoothMouse.y) * 0.075;
      wind.x = wind.x * 0.90 + (smoothMouse.x - previousMouse.x) * 2.8;
      wind.y = wind.y * 0.90 + (smoothMouse.y - previousMouse.y) * 2.8;

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(textureLocation, 0);
      gl.uniform2f(resolutionLocation, width, height);
      gl.uniform2f(imageResolutionLocation, imageWidth, imageHeight);
      gl.uniform2f(mouseLocation, smoothMouse.x, smoothMouse.y);
      gl.uniform2f(windLocation, wind.x, wind.y);
      gl.uniform1f(timeLocation, time);
      gl.uniform1f(imageReadyLocation, imageReady);

      gl.drawArrays(gl.TRIANGLES, 0, 6);
      animationId = window.requestAnimationFrame(render);
    };

    resize();
    render();
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    return () => {
      window.cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      if (buffer) gl.deleteBuffer(buffer);
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
    };
  }, []);

  return (
    <div className="dh-backdrop" aria-hidden="true">
      <div className="dh-sandscape" />
      <canvas ref={canvasRef} className="dh-webgl-canvas" />
      <div className="dh-vignette" />
    </div>
  );
}
