import { useEffect, useRef, useState } from 'react';

type DustParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  life: number;
  maxLife: number;
};

type PointerState = {
  x: number;
  y: number;
  nx: number;
  ny: number;
  speed: number;
  energy: number;
  active: boolean;
};

const MAX_DUST = 180;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const createPointerDust = (x: number, y: number, windX: number, windY: number): DustParticle => {
  const angle = Math.atan2(windY, windX) + (Math.random() - 0.5) * 1.1;
  const speed = 0.55 + Math.random() * 1.65;
  return {
    x: x + (Math.random() - 0.5) * 24,
    y: y + (Math.random() - 0.5) * 16,
    vx: Math.cos(angle) * speed + windX * 0.028,
    vy: Math.sin(angle) * speed + windY * 0.022 - 0.25 - Math.random() * 0.22,
    size: 0.5 + Math.random() * 1.35,
    alpha: 0.07 + Math.random() * 0.11,
    life: 0,
    maxLife: 72 + Math.random() * 62,
  };
};

const createAmbientDust = (width: number, height: number): DustParticle => ({
  x: Math.random() * width,
  y: height * (0.44 + Math.random() * 0.52),
  vx: 0.16 + Math.random() * 0.42,
  vy: -0.07 - Math.random() * 0.2,
  size: 0.35 + Math.random() * 0.8,
  alpha: 0.025 + Math.random() * 0.05,
  life: 0,
  maxLife: 170 + Math.random() * 190,
});

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_uvScale;
uniform vec2 u_uvOffset;
uniform vec2 u_pointer;
uniform vec2 u_resolution;
uniform float u_pointerEnergy;
uniform float u_time;

float softBand(float value, float center, float innerWidth, float feather) {
  return 1.0 - smoothstep(innerWidth, innerWidth + feather, abs(value - center));
}

float upperSilkMask(vec2 uv) {
  float right = smoothstep(0.47, 0.68, uv.x);
  float upper = smoothstep(0.48, 0.76, uv.y);
  float crest = 0.73 + 0.055 * sin(uv.x * 12.0 + 0.8);
  float ribbon = smoothstep(crest - 0.23, crest + 0.05, uv.y);
  return clamp(right * max(upper * 0.55, ribbon), 0.0, 1.0);
}

float lowerSilkMask(vec2 uv) {
  float broadLower = 1.0 - smoothstep(0.34, 0.62, uv.y);
  float ribbonOne = softBand(uv.y, 0.20 + 0.075 * sin(uv.x * 7.4 + 1.1), 0.035, 0.075);
  float ribbonTwo = softBand(uv.y, 0.34 + 0.065 * sin(uv.x * 8.6 - 0.7), 0.025, 0.07);
  float centerFade = smoothstep(0.02, 0.18, uv.x) * (1.0 - smoothstep(0.94, 1.02, uv.x));
  return clamp(max(broadLower * 0.38, max(ribbonOne, ribbonTwo)) * centerFade, 0.0, 1.0);
}

float middleSilkMask(vec2 uv) {
  float curve = 0.57 + 0.052 * sin((uv.x - 0.54) * 13.0 + 0.5);
  float strip = softBand(uv.y, curve, 0.018, 0.055);
  float horizontal = smoothstep(0.55, 0.68, uv.x) * (1.0 - smoothstep(0.88, 0.98, uv.x));
  return strip * horizontal;
}

float haloCorrectionMask(vec2 uv) {
  vec2 q = vec2((uv.x - 0.39) / 0.39, (uv.y - 0.58) / 0.235);
  float irregular = length(q)
    + 0.045 * sin(uv.x * 19.0 + uv.y * 4.0)
    + 0.035 * sin(uv.y * 23.0 - uv.x * 5.0);
  float mask = 1.0 - smoothstep(0.72, 1.15, irregular);
  mask *= 1.0 - smoothstep(0.68, 0.84, uv.x);
  return clamp(mask, 0.0, 1.0);
}

void main() {
  vec2 uv = u_uvOffset + v_uv * u_uvScale;
  vec2 pointerUv = u_uvOffset + u_pointer * u_uvScale;
  float silk = clamp(max(upperSilkMask(uv), max(lowerSilkMask(uv), middleSilkMask(uv))), 0.0, 1.0);

  vec2 pointerDelta = uv - pointerUv;
  pointerDelta.x *= u_resolution.x / max(u_resolution.y, 1.0);
  float pointerDistance = length(pointerDelta);
  float pointerFalloff = exp(-pointerDistance * pointerDistance * 22.0) * u_pointerEnergy;

  vec2 flow = vec2(
    sin(uv.y * 19.0 + u_time * 1.02) + 0.52 * sin(uv.x * 12.0 - u_time * 0.72),
    cos(uv.x * 16.0 - u_time * 0.86) + 0.42 * sin(uv.y * 15.0 + u_time * 0.68)
  );
  vec2 radial = pointerDelta / max(pointerDistance, 0.001);
  float ripple = sin(pointerDistance * 44.0 - u_time * 4.2);

  vec2 displacement = flow * (0.0038 + 0.0022 * u_pointerEnergy) * silk;
  displacement += radial * ripple * 0.0042 * pointerFalloff * (0.38 + 0.62 * silk);
  displacement += vec2(-radial.y, radial.x) * 0.0024 * pointerFalloff * silk;

  vec2 sampleUv = clamp(uv + displacement, vec2(0.001), vec2(0.999));
  vec3 color = texture2D(u_texture, sampleUv).rgb;

  float halo = haloCorrectionMask(uv);
  vec3 neutral = color;
  neutral.r *= 0.965;
  neutral.g *= 1.006;
  neutral.b *= 1.022;
  float luminance = dot(neutral, vec3(0.2126, 0.7152, 0.0722));
  neutral = mix(neutral, vec3(luminance), 0.065);
  neutral *= 0.992;
  color = mix(color, neutral, halo * 0.72);

  float silkLight = silk * (0.012 + 0.012 * sin(u_time * 0.9 + uv.x * 8.0));
  color += vec3(0.018, 0.013, 0.006) * silkLight;
  gl_FragColor = vec4(color, 1.0);
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
    const message = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
};

const createProgram = (gl: WebGLRenderingContext) => {
  const program = gl.createProgram();
  if (!program) {
    throw new Error('Unable to create WebGL program');
  }
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'Unknown WebGL link error';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
};

export function DunhuangBackdrop() {
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [shaderReady, setShaderReady] = useState(false);
  const [shaderFailed, setShaderFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const dustCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef<PointerState>({ x: 0, y: 0, nx: 0.5, ny: 0.5, speed: 0, energy: 0, active: false });

  useEffect(() => {
    const video = videoRef.current;
    const videoCanvas = videoCanvasRef.current;
    const dustCanvas = dustCanvasRef.current;
    if (!video || !videoCanvas || !dustCanvas) {
      return;
    }

    const dustContext = dustCanvas.getContext('2d', { alpha: true });
    if (!dustContext) {
      return;
    }

    let gl: WebGLRenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let texture: WebGLTexture | null = null;
    let positionBuffer: WebGLBuffer | null = null;
    let animationId = 0;
    let width = 1;
    let height = 1;
    let lastAmbientAt = 0;
    let lastVideoTime = -1;
    let firstShaderFrameDrawn = false;
    let destroyed = false;
    const particles: DustParticle[] = [];

    const locations: {
      position: number;
      uvScale: WebGLUniformLocation | null;
      uvOffset: WebGLUniformLocation | null;
      pointer: WebGLUniformLocation | null;
      resolution: WebGLUniformLocation | null;
      pointerEnergy: WebGLUniformLocation | null;
      time: WebGLUniformLocation | null;
      texture: WebGLUniformLocation | null;
    } = {
      position: -1,
      uvScale: null,
      uvOffset: null,
      pointer: null,
      resolution: null,
      pointerEnergy: null,
      time: null,
      texture: null,
    };

    try {
      gl = videoCanvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      });
      if (!gl) {
        throw new Error('WebGL unavailable');
      }
      program = createProgram(gl);
      gl.useProgram(program);

      positionBuffer = gl.createBuffer();
      if (!positionBuffer) {
        throw new Error('Unable to create WebGL buffer');
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
        1, -1,
        -1, 1,
        -1, 1,
        1, -1,
        1, 1,
      ]), gl.STATIC_DRAW);

      locations.position = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(locations.position);
      gl.vertexAttribPointer(locations.position, 2, gl.FLOAT, false, 0, 0);
      locations.uvScale = gl.getUniformLocation(program, 'u_uvScale');
      locations.uvOffset = gl.getUniformLocation(program, 'u_uvOffset');
      locations.pointer = gl.getUniformLocation(program, 'u_pointer');
      locations.resolution = gl.getUniformLocation(program, 'u_resolution');
      locations.pointerEnergy = gl.getUniformLocation(program, 'u_pointerEnergy');
      locations.time = gl.getUniformLocation(program, 'u_time');
      locations.texture = gl.getUniformLocation(program, 'u_texture');

      texture = gl.createTexture();
      if (!texture) {
        throw new Error('Unable to create video texture');
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.uniform1i(locations.texture, 0);
    } catch (error) {
      console.warn('Dunhuang WebGL renderer disabled:', error);
      setShaderFailed(true);
      gl = null;
      program = null;
    }

    const updateCoverUniforms = () => {
      if (!gl || !program) {
        return;
      }
      const videoWidth = video.videoWidth || 1920;
      const videoHeight = video.videoHeight || 1080;
      const screenAspect = width / Math.max(height, 1);
      const videoAspect = videoWidth / Math.max(videoHeight, 1);
      let scaleX = 1;
      let scaleY = 1;
      if (screenAspect > videoAspect) {
        scaleY = videoAspect / screenAspect;
      } else {
        scaleX = screenAspect / videoAspect;
      }
      gl.uniform2f(locations.uvScale, scaleX, scaleY);
      gl.uniform2f(locations.uvOffset, (1 - scaleX) / 2, (1 - scaleY) / 2);
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.35);
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);

      dustCanvas.width = Math.floor(width * dpr);
      dustCanvas.height = Math.floor(height * dpr);
      dustCanvas.style.width = `${width}px`;
      dustCanvas.style.height = `${height}px`;
      dustContext.setTransform(dpr, 0, 0, dpr, 0, 0);

      videoCanvas.width = Math.floor(width * dpr);
      videoCanvas.height = Math.floor(height * dpr);
      videoCanvas.style.width = `${width}px`;
      videoCanvas.style.height = `${height}px`;
      if (gl) {
        gl.viewport(0, 0, videoCanvas.width, videoCanvas.height);
        gl.useProgram(program);
        gl.uniform2f(locations.resolution, width, height);
        updateCoverUniforms();
      }
    };

    const onMouseMove = (event: MouseEvent) => {
      const pointer = pointerRef.current;
      if (!pointer.active) {
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        pointer.nx = event.clientX / Math.max(width, 1);
        pointer.ny = 1 - event.clientY / Math.max(height, 1);
        pointer.active = true;
        return;
      }

      const windX = event.clientX - pointer.x;
      const windY = event.clientY - pointer.y;
      const speed = Math.hypot(windX, windY);
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.nx = clamp(event.clientX / Math.max(width, 1), 0, 1);
      pointer.ny = clamp(1 - event.clientY / Math.max(height, 1), 0, 1);
      pointer.speed = speed;
      pointer.energy = Math.max(pointer.energy, clamp(speed / 28, 0.16, 1));

      const overWidget = event.target instanceof Element && Boolean(event.target.closest('.desktop-widget, .desktop-console-sidebar'));
      if (!overWidget && speed > 1.2) {
        const count = Math.min(12, Math.max(3, Math.floor(speed / 8)));
        for (let index = 0; index < count; index += 1) {
          if (particles.length >= MAX_DUST) {
            particles.shift();
          }
          particles.push(createPointerDust(event.clientX, event.clientY, windX, windY));
        }
      }
    };

    const onPointerLeave = () => {
      pointerRef.current.active = false;
      pointerRef.current.speed = 0;
    };

    const drawDust = (now: number) => {
      dustContext.clearRect(0, 0, width, height);
      if (now - lastAmbientAt > 58 && particles.length < 105) {
        particles.push(createAmbientDust(width, height));
        lastAmbientAt = now;
      }

      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        particle.life += 1;
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.vx *= 0.988;
        particle.vy = particle.vy * 0.986 - 0.0015;

        const t = particle.life / particle.maxLife;
        const alpha = particle.alpha * (1 - t) * Math.sin(Math.min(1, t * 1.8) * Math.PI * 0.5);
        if (t >= 1 || alpha <= 0.001) {
          particles.splice(index, 1);
          continue;
        }

        const radius = Math.max(0.35, particle.size * (1 + t * 0.65));
        dustContext.fillStyle = `rgba(137, 91, 44, ${alpha})`;
        dustContext.beginPath();
        dustContext.ellipse(particle.x, particle.y, radius * 1.35, radius, Math.atan2(particle.vy, particle.vx), 0, Math.PI * 2);
        dustContext.fill();
      }
    };

    const draw = (now: number) => {
      if (destroyed) {
        return;
      }
      const pointer = pointerRef.current;
      pointer.energy *= 0.94;
      pointer.speed *= 0.9;

      if (gl && program && texture && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (video.currentTime !== lastVideoTime) {
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
            lastVideoTime = video.currentTime;
          } catch (error) {
            console.warn('Video texture upload failed:', error);
            setShaderFailed(true);
            gl = null;
          }
        }
        if (gl) {
          gl.uniform2f(locations.pointer, pointer.nx, pointer.ny);
          gl.uniform1f(locations.pointerEnergy, pointer.energy);
          gl.uniform1f(locations.time, now / 1000);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          if (!firstShaderFrameDrawn) {
            firstShaderFrameDrawn = true;
            setShaderReady(true);
          }
        }
      }

      drawDust(now);
      animationId = window.requestAnimationFrame(draw);
    };

    resize();
    animationId = window.requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseleave', onPointerLeave);
    window.addEventListener('blur', onPointerLeave);
    video.addEventListener('loadedmetadata', updateCoverUniforms);

    return () => {
      destroyed = true;
      window.cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseleave', onPointerLeave);
      window.removeEventListener('blur', onPointerLeave);
      video.removeEventListener('loadedmetadata', updateCoverUniforms);
      if (gl) {
        if (texture) gl.deleteTexture(texture);
        if (positionBuffer) gl.deleteBuffer(positionBuffer);
        if (program) gl.deleteProgram(program);
      }
    };
  }, []);

  const handleVideoReady = () => {
    setVideoReady(true);
    setVideoFailed(false);
    void videoRef.current?.play().catch(() => undefined);
  };

  const useShader = videoReady && shaderReady && !shaderFailed;

  return (
    <div className="dh-backdrop" aria-hidden="true">
      <div className={`dh-image-fallback ${videoReady ? 'is-hidden' : ''}`} />
      {!videoFailed && (
        <video
          ref={videoRef}
          className={`dh-video-bg ${videoReady ? 'is-ready' : ''} ${useShader ? 'is-webgl-source' : ''}`}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          poster="/dunhuang-wallpaper.png"
          disablePictureInPicture
          onCanPlay={handleVideoReady}
          onLoadedData={handleVideoReady}
          onError={() => {
            setVideoFailed(true);
            setVideoReady(false);
            setShaderReady(false);
          }}
        >
          <source src="/dunhuang-loop.mp4" type="video/mp4" />
        </video>
      )}
      <canvas ref={videoCanvasRef} className={`dh-video-canvas ${useShader ? 'is-ready' : ''}`} />
      <canvas ref={dustCanvasRef} className="dh-interaction-canvas" />
      <div className="dh-vignette" />
    </div>
  );
}
