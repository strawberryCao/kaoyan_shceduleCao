import { useEffect, useRef, useState } from 'react';

type DustParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseVx: number;
  baseVy: number;
  radius: number;
  alpha: number;
  phase: number;
  phaseSpeed: number;
  life: number;
  maxLife: number;
  interactive: boolean;
};

type PointerState = {
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  active: boolean;
  energy: number;
  lastMoveAt: number;
};

type VideoCandidate = {
  src: string;
  type: string;
};

const VIDEO_CANDIDATES: VideoCandidate[] = [
  { src: '/dunhuang-master.webm', type: 'video/webm' },
  { src: '/dunhuang-master.mp4', type: 'video/mp4' },
];

const BASE_DUST = 96;
const MAX_DUST = 240;
const POINTER_RADIUS = 230;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function createAmbientDust(width: number, height: number): DustParticle {
  const baseVx = 0.04 + Math.random() * 0.13;
  const baseVy = -0.015 - Math.random() * 0.055;
  return {
    x: Math.random() * width,
    y: height * (0.36 + Math.random() * 0.62),
    vx: baseVx,
    vy: baseVy,
    baseVx,
    baseVy,
    radius: 0.55 + Math.random() * 0.9,
    alpha: 0.05 + Math.random() * 0.075,
    phase: Math.random() * Math.PI * 2,
    phaseSpeed: 0.005 + Math.random() * 0.013,
    life: 0,
    maxLife: Number.POSITIVE_INFINITY,
    interactive: false,
  };
}

function createInteractionDust(x: number, y: number, windX: number, windY: number): DustParticle {
  const angle = Math.random() * Math.PI * 2;
  const speed = Math.max(1, Math.hypot(windX, windY));
  const windScale = clamp(speed / 16, 0.25, 1.35);
  const baseVx = windX * 0.075 + Math.cos(angle) * (0.3 + Math.random() * 0.65) * windScale;
  const baseVy = windY * 0.06 + Math.sin(angle) * (0.24 + Math.random() * 0.55) * windScale - 0.1;

  return {
    x: x + (Math.random() - 0.5) * 30,
    y: y + (Math.random() - 0.5) * 24,
    vx: baseVx,
    vy: baseVy,
    baseVx,
    baseVy,
    radius: 0.85 + Math.random() * 1.35,
    alpha: 0.2 + Math.random() * 0.2,
    phase: Math.random() * Math.PI * 2,
    phaseSpeed: 0.018 + Math.random() * 0.025,
    life: 0,
    maxLife: 42 + Math.random() * 52,
    interactive: true,
  };
}

async function findAvailableVideo(signal: AbortSignal): Promise<VideoCandidate | null> {
  for (const candidate of VIDEO_CANDIDATES) {
    try {
      const response = await fetch(candidate.src, {
        method: 'HEAD',
        cache: 'no-store',
        signal,
      });
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (response.ok && (contentType.startsWith('video/') || contentType.includes('octet-stream'))) {
        return candidate;
      }
    } catch {
      if (signal.aborted) {
        return null;
      }
    }
  }
  return null;
}

export function DunhuangBackdrop() {
  const [videoSource, setVideoSource] = useState<VideoCandidate | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dustCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef<PointerState>({
    x: -1000,
    y: -1000,
    lastX: -1000,
    lastY: -1000,
    active: false,
    energy: 0,
    lastMoveAt: 0,
  });

  useEffect(() => {
    const controller = new AbortController();
    void findAvailableVideo(controller.signal).then((candidate) => {
      if (!controller.signal.aborted) {
        setVideoSource(candidate);
      }
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = dustCanvasRef.current;
    if (!root || !canvas) {
      return;
    }

    const context = canvas.getContext('2d', { alpha: true });
    if (!context) {
      return;
    }

    const particles: DustParticle[] = [];
    let width = 1;
    let height = 1;
    let animationId = 0;
    let previous = performance.now();

    const resize = () => {
      const rect = root.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      particles.length = 0;
      for (let index = 0; index < BASE_DUST; index += 1) {
        particles.push(createAmbientDust(width, height));
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const pointer = pointerRef.current;

      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        pointer.active = false;
        return;
      }

      const windX = pointer.active ? x - pointer.lastX : 0;
      const windY = pointer.active ? y - pointer.lastY : 0;
      const speed = Math.hypot(windX, windY);
      pointer.x = x;
      pointer.y = y;
      pointer.lastX = x;
      pointer.lastY = y;
      pointer.active = true;
      pointer.lastMoveAt = performance.now();
      pointer.energy = Math.max(pointer.energy, clamp(speed / 12, 0.2, 1));

      if (speed < 0.35) {
        return;
      }

      const count = Math.min(16, Math.max(4, Math.floor(speed / 2.8)));
      for (let index = 0; index < count; index += 1) {
        if (particles.length >= MAX_DUST) {
          const removable = particles.findIndex((particle) => particle.interactive);
          if (removable >= 0) {
            particles.splice(removable, 1);
          } else {
            break;
          }
        }
        particles.push(createInteractionDust(x, y, windX, windY));
      }
    };

    const deactivatePointer = () => {
      pointerRef.current.active = false;
    };

    const draw = (now: number) => {
      animationId = 0;
      if (document.hidden) {
        return;
      }
      const delta = clamp((now - previous) / (1000 / 60), 0.25, 2.5);
      previous = now;
      context.clearRect(0, 0, width, height);

      const pointer = pointerRef.current;
      if (now - pointer.lastMoveAt > 520) {
        pointer.active = false;
      }
      pointer.energy *= Math.pow(0.9, delta);

      for (let index = particles.length - 1; index >= 0; index -= 1) {
          const particle = particles[index];
          particle.phase += particle.phaseSpeed * delta;

          if (pointer.active) {
            const dx = particle.x - pointer.x;
            const dy = particle.y - pointer.y;
            const distance = Math.max(1, Math.hypot(dx, dy));
            if (distance < POINTER_RADIUS) {
              const falloff = 1 - distance / POINTER_RADIUS;
              const influence = falloff * falloff * (0.75 + pointer.energy * 1.65);
              const nx = dx / distance;
              const ny = dy / distance;
              const tangentX = -ny;
              const tangentY = nx;
              particle.vx += (nx * 0.105 + tangentX * 0.135) * influence * delta;
              particle.vy += (ny * 0.08 + tangentY * 0.105) * influence * delta;
            }
          }

          particle.vx += (particle.baseVx - particle.vx) * 0.015 * delta;
          particle.vy += (particle.baseVy - particle.vy) * 0.015 * delta;
          particle.x += (particle.vx + Math.sin(particle.phase) * 0.018) * delta;
          particle.y += (particle.vy + Math.cos(particle.phase * 0.73) * 0.01) * delta;

          if (particle.interactive) {
            particle.life += delta;
            if (particle.life >= particle.maxLife) {
              particles.splice(index, 1);
              continue;
            }
          } else if (particle.x > width + 8 || particle.y < height * 0.28 || particle.y > height + 8) {
            Object.assign(particle, createAmbientDust(width, height), {
              x: -5 - Math.random() * 18,
              y: height * (0.42 + Math.random() * 0.56),
            });
          }

          const lifeOpacity = particle.interactive
            ? Math.sin(Math.PI * clamp(particle.life / particle.maxLife, 0, 1))
            : 1;
          const alpha = particle.alpha * lifeOpacity;
          context.fillStyle = particle.interactive
            ? `rgba(104, 67, 31, ${alpha})`
            : `rgba(126, 88, 48, ${alpha})`;
          context.beginPath();
          context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
          context.fill();
      }

      animationId = window.requestAnimationFrame(draw);
    };

    const startAnimation = () => {
      if (document.hidden || animationId !== 0) return;
      previous = performance.now();
      animationId = window.requestAnimationFrame(draw);
    };

    const handleVisibility = () => {
      if (document.hidden) {
        if (animationId !== 0) window.cancelAnimationFrame(animationId);
        animationId = 0;
      } else {
        startAnimation();
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('blur', deactivatePointer);
    document.addEventListener('mouseleave', deactivatePointer);
    document.addEventListener('visibilitychange', handleVisibility);
    startAnimation();

    return () => {
      window.cancelAnimationFrame(animationId);
      observer.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('blur', deactivatePointer);
      document.removeEventListener('mouseleave', deactivatePointer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSource) {
      return;
    }

    const start = async () => {
      try {
        await video.play();
      } catch {
        // Chromium or Lively may delay autoplay until the page becomes visible.
      }
    };

    const handleCanPlay = () => void start();
    const handleVisibility = () => {
      if (document.hidden) {
        video.pause();
      } else {
        void start();
      }
    };

    video.addEventListener('canplay', handleCanPlay);
    document.addEventListener('visibilitychange', handleVisibility);
    if (video.readyState >= video.HAVE_FUTURE_DATA) {
      void start();
    }

    return () => {
      video.removeEventListener('canplay', handleCanPlay);
      document.removeEventListener('visibilitychange', handleVisibility);
      video.pause();
    };
  }, [videoSource]);

  return (
    <div ref={rootRef} className="dh-backdrop" aria-hidden="true">
      <div className="dh-image-base" />
      {videoSource && (
        <video
          ref={videoRef}
          className="dh-video-bg"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          poster="/dunhuang-wallpaper.png"
        >
          <source src={videoSource.src} type={videoSource.type} />
        </video>
      )}
      <canvas ref={dustCanvasRef} className="dh-dust-canvas" />
      <div className="dh-vignette" />
    </div>
  );
}
