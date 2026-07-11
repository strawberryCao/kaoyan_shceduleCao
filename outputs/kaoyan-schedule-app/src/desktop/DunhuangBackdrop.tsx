import { useEffect, useRef, useState } from 'react';

type DustParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  length: number;
  width: number;
  alpha: number;
  life: number;
  maxLife: number;
  warm: boolean;
};

type PointerState = {
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  active: boolean;
  energy: number;
};

const MAX_DUST = 420;
const BASE_DUST = 190;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const vertexShaderSource = `
attribute vec2 a_position;
attribute vec2 a_uv;
varying vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentShaderSource = `
precision highp float;

uniform sampler2D u_texture;
uniform float u_time;
uniform vec2 u_canvas_size;
uniform vec2 u_image_size;
uniform vec3 u_pointer;
varying vec2 v_uv;

float band(float value, float center, float half_width, float feather) {
  return 1.0 - smoothstep(half_width, half_width + feather, abs(value - center));
}

vec2 cover_uv(vec2 uv) {
  float canvas_aspect = u_canvas_size.x / max(u_canvas_size.y, 1.0);
  float image_aspect = u_image_size.x / max(u_image_size.y, 1.0);
  vec2 scale = vec2(1.0);

  if (canvas_aspect > image_aspect) {
    scale.y = image_aspect / canvas_aspect;
  } else {
    scale.x = canvas_aspect / image_aspect;
  }

  return (uv - 0.5) * scale + 0.5;
}

void main() {
  vec2 scene_uv = cover_uv(v_uv);
  vec2 displaced_uv = scene_uv;
  float t = u_time;

  float upper_center = 0.155 + (scene_uv.x - 0.52) * 0.58
    + 0.018 * sin(scene_uv.x * 13.0 + 0.8);
  float upper_mask = smoothstep(0.50, 0.63, scene_uv.x)
    * band(scene_uv.y, upper_center, 0.115, 0.055)
    * (1.0 - smoothstep(0.80, 1.02, scene_uv.y));

  float middle_center = 0.355 + (scene_uv.x - 0.58) * 0.27
    + 0.024 * sin(scene_uv.x * 11.0 + 2.1);
  float middle_mask = smoothstep(0.55, 0.67, scene_uv.x)
    * band(scene_uv.y, middle_center, 0.075, 0.040);

  float lower_center = 0.765 - scene_uv.x * 0.125
    + 0.030 * sin(scene_uv.x * 8.5 + 1.5);
  float lower_mask = band(scene_uv.y, lower_center, 0.105, 0.050)
    * (1.0 - smoothstep(0.98, 1.08, scene_uv.y));

  float silk_mask = clamp(max(upper_mask, max(middle_mask, lower_mask)), 0.0, 1.0);
  float pointer_distance = distance(v_uv, u_pointer.xy);
  float gust = u_pointer.z * exp(-pointer_distance * pointer_distance * 52.0);
  float response = 1.0 + gust * 1.9;

  vec2 upper_warp = vec2(
    0.0075 * sin(t * 0.92 + scene_uv.y * 19.0)
      + 0.0030 * sin(t * 1.73 + scene_uv.x * 31.0),
    0.0085 * sin(t * 0.76 + scene_uv.x * 13.0 + 0.7)
      + 0.0025 * sin(t * 1.35 + scene_uv.y * 27.0)
  );

  vec2 middle_warp = vec2(
    0.0065 * sin(t * 1.08 + scene_uv.y * 24.0 + 1.6),
    0.0060 * sin(t * 0.88 + scene_uv.x * 17.0 + 2.4)
  );

  vec2 lower_warp = vec2(
    0.0095 * sin(t * 0.67 + scene_uv.y * 16.0 + 2.1)
      + 0.0025 * sin(t * 1.41 + scene_uv.x * 24.0),
    0.0065 * sin(t * 0.81 + scene_uv.x * 12.0 + 1.2)
  );

  displaced_uv += response * (
    upper_warp * upper_mask
    + middle_warp * middle_mask
    + lower_warp * lower_mask
  );

  displaced_uv = clamp(displaced_uv, vec2(0.001), vec2(0.999));
  vec4 color = texture2D(u_texture, displaced_uv);

  float fabric_luminance = silk_mask * (
    0.010 * sin(t * 0.74 + scene_uv.x * 18.0 - scene_uv.y * 10.0)
    + 0.006 * sin(t * 1.16 + scene_uv.y * 24.0)
  );
  color.rgb *= 1.0 + fabric_luminance;

  gl_FragColor = color;
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('无法创建 WebGL shader');
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || '未知 shader 编译错误';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGLRenderingContext) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error('无法创建 WebGL program');
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || '未知 program 链接错误';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function createAmbientDust(width: number, height: number): DustParticle {
  const speed = 0.28 + Math.random() * 0.72;
  return {
    x: -80 + Math.random() * (width + 160),
    y: height * (0.38 + Math.random() * 0.62),
    vx: speed,
    vy: -0.09 - Math.random() * 0.32,
    length: 2.5 + Math.random() * 9.5,
    width: 0.45 + Math.random() * 1.15,
    alpha: 0.08 + Math.random() * 0.20,
    life: Math.random() * 160,
    maxLife: 280 + Math.random() * 360,
    warm: Math.random() > 0.28,
  };
}

function createGustDust(x: number, y: number, windX: number, windY: number): DustParticle {
  const magnitude = clamp(Math.hypot(windX, windY), 1, 42);
  const angle = Math.atan2(windY, windX) + (Math.random() - 0.5) * 0.8;
  const speed = 0.9 + Math.random() * 2.7 + magnitude * 0.025;
  return {
    x: x + (Math.random() - 0.5) * 30,
    y: y + (Math.random() - 0.5) * 18,
    vx: Math.cos(angle) * speed + windX * 0.035,
    vy: Math.sin(angle) * speed + windY * 0.025 - 0.22,
    length: 5 + Math.random() * 17,
    width: 0.55 + Math.random() * 1.25,
    alpha: 0.16 + Math.random() * 0.28,
    life: 0,
    maxLife: 80 + Math.random() * 110,
    warm: Math.random() > 0.15,
  };
}

export function DunhuangBackdrop() {
  const [sceneReady, setSceneReady] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sceneCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dustCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef<PointerState>({ x: 0.5, y: 0.5, lastX: 0, lastY: 0, active: false, energy: 0 });

  useEffect(() => {
    const root = rootRef.current;
    const sceneCanvas = sceneCanvasRef.current;
    const dustCanvas = dustCanvasRef.current;
    if (!root || !sceneCanvas || !dustCanvas) {
      return;
    }

    const dustContext = dustCanvas.getContext('2d', { alpha: true });
    if (!dustContext) {
      return;
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const particles: DustParticle[] = [];
    let width = 1;
    let height = 1;
    let dpr = 1;
    let animationId = 0;
    let lastFrameAt = performance.now();
    let gl: WebGLRenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let texture: WebGLTexture | null = null;
    let imageWidth = 1920;
    let imageHeight = 1080;
    let sceneCanRender = false;
    let disposed = false;
    let timeLocation: WebGLUniformLocation | null = null;
    let canvasSizeLocation: WebGLUniformLocation | null = null;
    let imageSizeLocation: WebGLUniformLocation | null = null;
    let pointerLocation: WebGLUniformLocation | null = null;

    const resize = () => {
      const rect = root.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);

      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (sceneCanvas.width !== pixelWidth || sceneCanvas.height !== pixelHeight) {
        sceneCanvas.width = pixelWidth;
        sceneCanvas.height = pixelHeight;
      }
      if (dustCanvas.width !== pixelWidth || dustCanvas.height !== pixelHeight) {
        dustCanvas.width = pixelWidth;
        dustCanvas.height = pixelHeight;
      }

      sceneCanvas.style.width = `${width}px`;
      sceneCanvas.style.height = `${height}px`;
      dustCanvas.style.width = `${width}px`;
      dustCanvas.style.height = `${height}px`;
      dustContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      gl?.viewport(0, 0, pixelWidth, pixelHeight);

      while (particles.length < BASE_DUST) {
        particles.push(createAmbientDust(width, height));
      }
    };

    const onMouseMove = (event: MouseEvent) => {
      const rect = root.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        pointerRef.current.active = false;
        return;
      }

      const pointer = pointerRef.current;
      const windX = pointer.active ? x - pointer.lastX : 0;
      const windY = pointer.active ? y - pointer.lastY : 0;
      const speed = Math.hypot(windX, windY);
      pointer.x = clamp(x / Math.max(rect.width, 1), 0, 1);
      pointer.y = clamp(y / Math.max(rect.height, 1), 0, 1);
      pointer.lastX = x;
      pointer.lastY = y;
      pointer.active = true;
      pointer.energy = Math.max(pointer.energy, clamp(speed / 28, 0, 1));

      const target = event.target instanceof Element ? event.target : null;
      const overUi = Boolean(target?.closest('.desktop-widget, .desktop-console-sidebar, .desktop-control-dock'));
      if (!overUi && speed > 0.8) {
        const count = Math.min(24, Math.max(4, Math.floor(speed / 3.5)));
        for (let index = 0; index < count; index += 1) {
          if (particles.length >= MAX_DUST) {
            particles.shift();
          }
          particles.push(createGustDust(x, y, windX, windY));
        }
      }
    };

    const deactivatePointer = () => {
      pointerRef.current.active = false;
    };

    const drawDust = (delta: number) => {
      dustContext.clearRect(0, 0, width, height);
      dustContext.globalCompositeOperation = 'source-over';
      dustContext.lineCap = 'round';

      while (particles.length < BASE_DUST) {
        particles.push(createAmbientDust(width, height));
      }

      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        particle.life += delta;
        particle.x += particle.vx * delta;
        particle.y += particle.vy * delta;
        particle.vx += 0.0018 * delta;
        particle.vy -= 0.0008 * delta;

        const progress = particle.life / particle.maxLife;
        if (progress >= 1 || particle.x > width + 110 || particle.y < -80 || particle.y > height + 80) {
          particles.splice(index, 1);
          continue;
        }

        const fadeIn = Math.min(1, progress * 8);
        const fadeOut = Math.pow(Math.max(0, 1 - progress), 1.25);
        const alpha = particle.alpha * fadeIn * fadeOut;
        const velocity = Math.max(0.4, Math.hypot(particle.vx, particle.vy));
        const tailScale = particle.length * clamp(velocity / 1.5, 0.65, 2.2);
        const tailX = particle.x - (particle.vx / velocity) * tailScale;
        const tailY = particle.y - (particle.vy / velocity) * tailScale;

        dustContext.strokeStyle = particle.warm
          ? `rgba(151, 105, 53, ${alpha})`
          : `rgba(87, 116, 111, ${alpha * 0.72})`;
        dustContext.lineWidth = particle.width;
        dustContext.beginPath();
        dustContext.moveTo(tailX, tailY);
        dustContext.lineTo(particle.x, particle.y);
        dustContext.stroke();
      }
    };

    const renderScene = (now: number) => {
      if (!gl || !program || !sceneCanRender) {
        return;
      }

      const pointer = pointerRef.current;
      pointer.energy *= 0.92;
      if (pointer.energy < 0.002) {
        pointer.energy = 0;
      }

      gl.useProgram(program);
      gl.uniform1f(timeLocation, now / 1000);
      gl.uniform2f(canvasSizeLocation, width, height);
      gl.uniform2f(imageSizeLocation, imageWidth, imageHeight);
      gl.uniform3f(pointerLocation, pointer.x, pointer.y, pointer.energy);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const draw = (now: number) => {
      const delta = clamp((now - lastFrameAt) / (1000 / 60), 0.25, 3);
      lastFrameAt = now;
      if (!document.hidden) {
        if (!reducedMotion) {
          renderScene(now);
          drawDust(delta);
        } else if (sceneCanRender) {
          renderScene(0);
        }
      }
      animationId = window.requestAnimationFrame(draw);
    };

    try {
      gl = sceneCanvas.getContext('webgl', {
        alpha: false,
        antialias: true,
        depth: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      });

      if (gl) {
        program = createProgram(gl);
        gl.useProgram(program);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.clearColor(0.91, 0.87, 0.80, 1);

        const quad = gl.createBuffer();
        if (!quad) {
          throw new Error('无法创建 WebGL buffer');
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
          -1, -1, 0, 1,
           1, -1, 1, 1,
          -1,  1, 0, 0,
          -1,  1, 0, 0,
           1, -1, 1, 1,
           1,  1, 1, 0,
        ]), gl.STATIC_DRAW);

        const positionLocation = gl.getAttribLocation(program, 'a_position');
        const uvLocation = gl.getAttribLocation(program, 'a_uv');
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(uvLocation);
        gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 16, 8);

        texture = gl.createTexture();
        if (!texture) {
          throw new Error('无法创建 WebGL texture');
        }
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0);
        timeLocation = gl.getUniformLocation(program, 'u_time');
        canvasSizeLocation = gl.getUniformLocation(program, 'u_canvas_size');
        imageSizeLocation = gl.getUniformLocation(program, 'u_image_size');
        pointerLocation = gl.getUniformLocation(program, 'u_pointer');

        const image = new Image();
        image.decoding = 'async';
        image.src = '/dunhuang-wallpaper.png';
        image.onload = () => {
          if (disposed || !gl || !texture) {
            return;
          }
          imageWidth = image.naturalWidth || 1920;
          imageHeight = image.naturalHeight || 1080;
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
          sceneCanRender = true;
          renderScene(performance.now());
          setSceneReady(true);
        };
        image.onerror = () => {
          sceneCanRender = false;
          setSceneReady(false);
        };
      }
    } catch (error) {
      console.warn('敦煌 GPU 动态背景初始化失败，保留静态底图与沙尘层。', error);
      sceneCanRender = false;
      setSceneReady(false);
    }

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseleave', deactivatePointer);
    window.addEventListener('blur', deactivatePointer);
    animationId = window.requestAnimationFrame(draw);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationId);
      observer.disconnect();
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', deactivatePointer);
      window.removeEventListener('blur', deactivatePointer);
      if (gl) {
        if (texture) {
          gl.deleteTexture(texture);
        }
        if (program) {
          gl.deleteProgram(program);
        }
      }
    };
  }, []);

  return (
    <div ref={rootRef} className="dh-backdrop" aria-hidden="true">
      <div className={`dh-image-fallback ${sceneReady ? 'is-hidden' : ''}`} />
      <canvas ref={sceneCanvasRef} className={`dh-scene-canvas ${sceneReady ? 'is-ready' : ''}`} />
      <canvas ref={dustCanvasRef} className="dh-interaction-canvas" />
      <div className="dh-vignette" />
    </div>
  );
}
