import { useEffect, useRef, useState } from 'react';

type DustParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  alpha: number;
  phase: number;
  phaseSpeed: number;
};

type VideoCandidate = {
  src: string;
  type: string;
};

type PointerState = {
  x: number;
  y: number;
  previousX: number;
  previousY: number;
  velocityX: number;
  velocityY: number;
  active: boolean;
};

const VIDEO_CANDIDATES: VideoCandidate[] = [
  { src: '/dunhuang-master.webm', type: 'video/webm' },
  { src: '/dunhuang-master.mp4', type: 'video/mp4' },
  { src: '/dunhuang-reference.mp4', type: 'video/mp4' },
];

const BASE_DUST = 46;
const CROSSFADE_SECONDS = 0.8;
const POINTER_RADIUS = 118;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function createDust(width: number, height: number): DustParticle {
  return {
    x: Math.random() * width,
    y: height * (0.46 + Math.random() * 0.52),
    vx: 0.022 + Math.random() * 0.072,
    vy: -0.006 - Math.random() * 0.024,
    radius: 0.32 + Math.random() * 0.72,
    alpha: 0.012 + Math.random() * 0.032,
    phase: Math.random() * Math.PI * 2,
    phaseSpeed: 0.004 + Math.random() * 0.008,
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
  const [videoReady, setVideoReady] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstVideoRef = useRef<HTMLVideoElement | null>(null);
  const secondVideoRef = useRef<HTMLVideoElement | null>(null);
  const dustCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerRef = useRef<PointerState>({
    x: 0,
    y: 0,
    previousX: 0,
    previousY: 0,
    velocityX: 0,
    velocityY: 0,
    active: false,
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
      const dpr = Math.min(window.devicePixelRatio || 1, 1.35);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      particles.length = 0;
      for (let index = 0; index < BASE_DUST; index += 1) {
        particles.push(createDust(width, height));
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        pointerRef.current.active = false;
        return;
      }

      const pointer = pointerRef.current;
      const target = event.target instanceof Element ? event.target : null;
      const overUi = Boolean(target?.closest('.desktop-widget, .desktop-console-sidebar, .desktop-control-dock'));
      if (overUi) {
        pointer.active = false;
        return;
      }

      pointer.velocityX = pointer.active ? x - pointer.previousX : 0;
      pointer.velocityY = pointer.active ? y - pointer.previousY : 0;
      pointer.previousX = x;
      pointer.previousY = y;
      pointer.x = x;
      pointer.y = y;
      pointer.active = true;
    };

    const deactivatePointer = () => {
      pointerRef.current.active = false;
    };

    const draw = (now: number) => {
      const delta = clamp((now - previous) / (1000 / 60), 0.25, 2.5);
      previous = now;
      context.clearRect(0, 0, width, height);

      const pointer = pointerRef.current;
      pointer.velocityX *= 0.82;
      pointer.velocityY *= 0.82;

      if (!reducedMotion && !document.hidden) {
        for (const particle of particles) {
          particle.phase += particle.phaseSpeed * delta;
          particle.vx += Math.sin(particle.phase) * 0.00016 * delta;
          particle.vy += Math.cos(particle.phase * 0.73) * 0.00008 * delta;

          if (pointer.active) {
            const dx = particle.x - pointer.x;
            const dy = particle.y - pointer.y;
            const distance = Math.hypot(dx, dy);
            if (distance > 0.01 && distance < POINTER_RADIUS) {
              const influence = 1 - distance / POINTER_RADIUS;
              const normalX = dx / distance;
              const normalY = dy / distance;
              const tangentX = -normalY;
              const tangentY = normalX;
              const speed = clamp(Math.hypot(pointer.velocityX, pointer.velocityY) / 24, 0, 1);

              particle.vx += (normalX * 0.018 + tangentX * pointer.velocityX * 0.0014) * influence * speed;
              particle.vy += (normalY * 0.014 + tangentY * pointer.velocityY * 0.0011) * influence * speed;
            }
          }

          particle.vx += (0.055 - particle.vx) * 0.006 * delta;
          particle.vy += (-0.018 - particle.vy) * 0.006 * delta;
          particle.x += particle.vx * delta;
          particle.y += particle.vy * delta;

          if (particle.x > width + 6 || particle.y < height * 0.38 || particle.y > height + 6) {
            Object.assign(particle, createDust(width, height), {
              x: -4 - Math.random() * 12,
              y: height * (0.54 + Math.random() * 0.44),
            });
          }

          context.fillStyle = `rgba(126, 91, 52, ${particle.alpha})`;
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
    window.addEventListener('pointerleave', deactivatePointer);
    window.addEventListener('blur', deactivatePointer);
    animationId = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(animationId);
      observer.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', deactivatePointer);
      window.removeEventListener('blur', deactivatePointer);
    };
  }, []);

  useEffect(() => {
    if (!videoSource) {
      setVideoReady(false);
      return;
    }

    const first = firstVideoRef.current;
    const second = secondVideoRef.current;
    if (!first || !second) {
      return;
    }

    const videos: [HTMLVideoElement, HTMLVideoElement] = [first, second];
    let activeIndex: 0 | 1 = 0;
    let transitionInProgress = false;
    let animationId = 0;
    let transitionTimer = 0;
    let disposed = false;
    let started = false;

    const resetVideo = (video: HTMLVideoElement) => {
      video.pause();
      try {
        video.currentTime = 0;
      } catch {
        // Metadata may not be available yet.
      }
    };

    const start = async () => {
      if (disposed || started) {
        return;
      }
      started = true;
      first.classList.add('is-visible');
      second.classList.remove('is-visible');
      resetVideo(second);
      try {
        await first.play();
        if (!disposed) {
          setVideoReady(true);
        }
      } catch {
        started = false;
        if (!disposed) {
          setVideoReady(false);
        }
      }
    };

    const monitor = () => {
      const active = videos[activeIndex];
      const standbyIndex: 0 | 1 = activeIndex === 0 ? 1 : 0;
      const standby = videos[standbyIndex];
      if (
        !transitionInProgress
        && Number.isFinite(active.duration)
        && active.duration > CROSSFADE_SECONDS * 2
        && active.duration - active.currentTime <= CROSSFADE_SECONDS
      ) {
        transitionInProgress = true;
        try {
          standby.currentTime = 0;
        } catch {
          // Ignore until metadata is ready.
        }
        void standby.play().then(() => {
          if (disposed) {
            return;
          }
          standby.classList.add('is-visible');
          active.classList.remove('is-visible');
          transitionTimer = window.setTimeout(() => {
            resetVideo(active);
            activeIndex = standbyIndex;
            transitionInProgress = false;
          }, CROSSFADE_SECONDS * 1000 + 80);
        }).catch(() => {
          transitionInProgress = false;
        });
      }
      animationId = window.requestAnimationFrame(monitor);
    };

    const handleCanPlay = () => void start();
    const handleError = () => {
      started = false;
      setVideoReady(false);
    };

    first.addEventListener('canplay', handleCanPlay);
    first.addEventListener('error', handleError);
    second.addEventListener('error', handleError);
    if (first.readyState >= first.HAVE_FUTURE_DATA) {
      void start();
    }
    animationId = window.requestAnimationFrame(monitor);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationId);
      window.clearTimeout(transitionTimer);
      first.removeEventListener('canplay', handleCanPlay);
      first.removeEventListener('error', handleError);
      second.removeEventListener('error', handleError);
      resetVideo(first);
      resetVideo(second);
    };
  }, [videoSource]);

  return (
    <div ref={rootRef} className="dh-backdrop" aria-hidden="true">
      <div className={`dh-image-fallback ${videoReady ? 'is-covered' : ''}`} />
      {videoSource && (
        <div className="dh-video-stack">
          <video ref={firstVideoRef} className="dh-video-bg" muted playsInline preload="auto" poster="/dunhuang-wallpaper.png">
            <source src={videoSource.src} type={videoSource.type} />
          </video>
          <video ref={secondVideoRef} className="dh-video-bg" muted playsInline preload="auto" poster="/dunhuang-wallpaper.png">
            <source src={videoSource.src} type={videoSource.type} />
          </video>
        </div>
      )}
      <canvas ref={dustCanvasRef} className="dh-dust-canvas" />
      <div className="dh-vignette" />
    </div>
  );
}
