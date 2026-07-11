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
};

type VideoCandidate = {
  src: string;
  type: string;
};

const VIDEO_CANDIDATES: VideoCandidate[] = [
  { src: '/dunhuang-master.webm', type: 'video/webm' },
  { src: '/dunhuang-master.mp4', type: 'video/mp4' },
  { src: '/dunhuang-reference.mp4', type: 'video/mp4' },
];

const BASE_DUST = 78;
const MAX_DUST = 150;
const VIDEO_BASE_OPACITY = 0.52;
const LOOP_FADE_SECONDS = 1.05;
const POINTER_RADIUS = 168;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 0.0001), 0, 1);
  return t * t * (3 - 2 * t);
}

function createAmbientDust(width: number, height: number): DustParticle {
  const baseVx = 0.035 + Math.random() * 0.11;
  const baseVy = -0.012 - Math.random() * 0.045;
  return {
    x: Math.random() * width,
    y: height * (0.42 + Math.random() * 0.56),
    vx: baseVx,
    vy: baseVy,
    baseVx,
    baseVy,
    radius: 0.42 + Math.random() * 0.95,
    alpha: 0.035 + Math.random() * 0.065,
    phase: Math.random() * Math.PI * 2,
    phaseSpeed: 0.004 + Math.random() * 0.012,
    life: 0,
    maxLife: Number.POSITIVE_INFINITY,
    interactive: false,
  };
}

function createInteractionDust(x: number, y: number, windX: number, windY: number): DustParticle {
  const spread = Math.random() * Math.PI * 2;
  const baseVx = windX * 0.055 + Math.cos(spread) * (0.22 + Math.random() * 0.5);
  const baseVy = windY * 0.045 + Math.sin(spread) * (0.18 + Math.random() * 0.42) - 0.08;
  return {
    x: x + (Math.random() - 0.5) * 22,
    y: y + (Math.random() - 0.5) * 16,
    vx: baseVx,
    vy: baseVy,
    baseVx,
    baseVy,
    radius: 0.7 + Math.random() * 1.25,
    alpha: 0.12 + Math.random() * 0.15,
    phase: Math.random() * Math.PI * 2,
    phaseSpeed: 0.015 + Math.random() * 0.02,
    life: 0,
    maxLife: 52 + Math.random() * 54,
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

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const particles: DustParticle[] = [];
    let width = 1;
    let height = 1;
    let animationId = 0;
    let previous = performance.now();

    const resize = () => {
      const rect = root.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
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
      pointer.energy = Math.max(pointer.energy, clamp(speed / 18, 0, 1));

      const target = event.target instanceof Element ? event.target : null;
      const overUi = Boolean(target?.closest('.desktop-widget, .desktop-console-sidebar, .desktop-control-dock'));
      if (reducedMotion || overUi || speed < 1.1) {
        return;
      }

      const count = Math.min(9, Math.max(2, Math.floor(speed / 4.5)));
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
      const delta = clamp((now - previous) / (1000 / 60), 0.25, 2.5);
      previous = now;
      context.clearRect(0, 0, width, height);

      const pointer = pointerRef.current;
      pointer.energy *= Math.pow(0.91, delta);

      if (!reducedMotion && !document.hidden) {
        for (let index = particles.length - 1; index >= 0; index -= 1) {
          const particle = particles[index];
          particle.phase += particle.phaseSpeed * delta;

          if (pointer.active) {
            const dx = particle.x - pointer.x;
            const dy = particle.y - pointer.y;
            const distance = Math.max(1, Math.hypot(dx, dy));
            if (distance < POINTER_RADIUS) {
              const influence = (1 - distance / POINTER_RADIUS) * (0.32 + pointer.energy * 0.95);
              const nx = dx / distance;
              const ny = dy / distance;
              const tangentX = -ny;
              const tangentY = nx;
              particle.vx += (nx * 0.032 + tangentX * 0.052) * influence * delta;
              particle.vy += (ny * 0.024 + tangentY * 0.041) * influence * delta;
            }
          }

          particle.vx += (particle.baseVx - particle.vx) * 0.018 * delta;
          particle.vy += (particle.baseVy - particle.vy) * 0.018 * delta;
          particle.x += (particle.vx + Math.sin(particle.phase) * 0.015) * delta;
          particle.y += (particle.vy + Math.cos(particle.phase * 0.73) * 0.008) * delta;

          if (particle.interactive) {
            particle.life += delta;
            if (particle.life >= particle.maxLife) {
              particles.splice(index, 1);
              continue;
            }
          } else if (particle.x > width + 5 || particle.y < height * 0.34 || particle.y > height + 5) {
            Object.assign(particle, createAmbientDust(width, height), {
              x: -4 - Math.random() * 14,
              y: height * (0.48 + Math.random() * 0.5),
            });
          }

          const lifeOpacity = particle.interactive
            ? Math.sin(Math.PI * clamp(particle.life / particle.maxLife, 0, 1))
            : 1;
          const alpha = particle.alpha * lifeOpacity;
          context.fillStyle = particle.interactive
            ? `rgba(132, 91, 48, ${alpha})`
            : `rgba(139, 101, 59, ${alpha})`;
          context.beginPath();
          context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
          context.fill();
        }
      }

      animationId = window.requestAnimationFrame(draw);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('blur', deactivatePointer);
    document.addEventListener('mouseleave', deactivatePointer);
    animationId = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(animationId);
      observer.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('blur', deactivatePointer);
      document.removeEventListener('mouseleave', deactivatePointer);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSource) {
      return;
    }

    let animationId = 0;
    let disposed = false;

    const start = async () => {
      try {
        await video.play();
      } catch {
        // Chromium or Lively may delay autoplay until the page is visible.
      }
    };

    const updateOpacity = () => {
      if (disposed) {
        return;
      }

      if (Number.isFinite(video.duration) && video.duration > LOOP_FADE_SECONDS * 2) {
        const fadeIn = smoothstep(0, LOOP_FADE_SECONDS, video.currentTime);
        const fadeOut = smoothstep(0, LOOP_FADE_SECONDS, video.duration - video.currentTime);
        const envelope = fadeIn * fadeOut;
        video.style.opacity = `${VIDEO_BASE_OPACITY * envelope}`;
      } else {
        video.style.opacity = `${VIDEO_BASE_OPACITY}`;
      }

      animationId = window.requestAnimationFrame(updateOpacity);
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
    animationId = window.requestAnimationFrame(updateOpacity);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationId);
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
