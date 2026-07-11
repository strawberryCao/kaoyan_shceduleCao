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

const MAX_DUST = 72;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const createPointerDust = (x: number, y: number, windX: number, windY: number): DustParticle => {
  const angle = Math.atan2(windY, windX) + (Math.random() - 0.5) * 0.72;
  const speed = 0.34 + Math.random() * 0.9;
  return {
    x: x + (Math.random() - 0.5) * 14,
    y: y + (Math.random() - 0.5) * 10,
    vx: Math.cos(angle) * speed + windX * 0.022,
    vy: Math.sin(angle) * speed + windY * 0.022 - Math.random() * 0.15,
    size: 0.34 + Math.random() * 0.72,
    alpha: 0.05 + Math.random() * 0.065,
    life: 0,
    maxLife: 64 + Math.random() * 48,
  };
};

const createAmbientDust = (width: number, height: number): DustParticle => ({
  x: Math.random() * width,
  y: height * (0.5 + Math.random() * 0.46),
  vx: 0.09 + Math.random() * 0.24,
  vy: -0.035 - Math.random() * 0.11,
  size: 0.24 + Math.random() * 0.44,
  alpha: 0.018 + Math.random() * 0.032,
  life: 0,
  maxLife: 190 + Math.random() * 170,
});

export function DunhuangBackdrop() {
  const [videoReady, setVideoReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const wakeVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef({ x: 0, y: 0, active: false });

  useEffect(() => {
    if (!videoReady) {
      return;
    }

    const mainVideo = videoRef.current;
    const wakeVideo = wakeVideoRef.current;
    if (!mainVideo || !wakeVideo) {
      return;
    }

    const syncVideos = () => {
      if (wakeVideo.readyState < 2 || mainVideo.readyState < 2) {
        return;
      }
      if (Math.abs(wakeVideo.currentTime - mainVideo.currentTime) > 0.08) {
        wakeVideo.currentTime = mainVideo.currentTime;
      }
      if (!mainVideo.paused && wakeVideo.paused) {
        void wakeVideo.play().catch(() => undefined);
      }
    };

    syncVideos();
    const timer = window.setInterval(syncVideos, 600);
    mainVideo.addEventListener('play', syncVideos);
    mainVideo.addEventListener('seeked', syncVideos);

    return () => {
      window.clearInterval(timer);
      mainVideo.removeEventListener('play', syncVideos);
      mainVideo.removeEventListener('seeked', syncVideos);
    };
  }, [videoReady]);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) {
      return;
    }

    const context = canvas.getContext('2d', { alpha: true });
    if (!context) {
      return;
    }

    let animationId = 0;
    let width = 1;
    let height = 1;
    let wakeStrength = 0;
    let lastMoveAt = 0;
    let lastAmbientAt = 0;
    const particles: DustParticle[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.max(1, window.innerWidth);
      height = Math.max(1, window.innerHeight);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const onPointerMove = (event: PointerEvent) => {
      const pointer = pointerRef.current;
      if (!pointer.active) {
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        pointer.active = true;
        root.style.setProperty('--dh-pointer-x', `${event.clientX}px`);
        root.style.setProperty('--dh-pointer-y', `${event.clientY}px`);
        return;
      }

      const windX = event.clientX - pointer.x;
      const windY = event.clientY - pointer.y;
      const speed = Math.hypot(windX, windY);
      pointer.x = event.clientX;
      pointer.y = event.clientY;

      const overWidget = event.target instanceof Element && Boolean(event.target.closest('.desktop-widget'));
      const interactionScale = overWidget ? 0.25 : 1;
      wakeStrength = clamp((speed / 28) * interactionScale, 0, 1);
      lastMoveAt = performance.now();

      root.style.setProperty('--dh-pointer-x', `${event.clientX}px`);
      root.style.setProperty('--dh-pointer-y', `${event.clientY}px`);
      root.style.setProperty('--dh-wake-x', `${clamp(windX * 0.17, -12, 12)}px`);
      root.style.setProperty('--dh-wake-y', `${clamp(windY * 0.14, -9, 9)}px`);
      root.style.setProperty('--dh-wake-angle', `${clamp(Math.atan2(windY, windX) * 8, -12, 12)}deg`);

      if (!overWidget && speed > 6) {
        const count = Math.min(5, Math.floor(speed / 22) + 1);
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
      wakeStrength = 0;
      root.style.setProperty('--dh-wake-strength', '0');
    };

    const draw = (now: number) => {
      context.clearRect(0, 0, width, height);
      context.save();
      context.globalCompositeOperation = 'source-over';

      if (now - lastAmbientAt > 150 && particles.length < 34) {
        particles.push(createAmbientDust(width, height));
        lastAmbientAt = now;
      }

      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index];
        particle.life += 1;
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.vx *= 0.991;
        particle.vy = particle.vy * 0.989 - 0.0008;

        const t = particle.life / particle.maxLife;
        const alpha = particle.alpha * (1 - t) * (0.38 + 0.62 * Math.sin(t * Math.PI));
        if (t >= 1 || alpha <= 0.001) {
          particles.splice(index, 1);
          continue;
        }

        const radius = particle.size * (1 + t * 0.55);
        const glowRadius = radius * 1.48;
        const gradient = context.createRadialGradient(particle.x, particle.y, 0, particle.x, particle.y, glowRadius);
        gradient.addColorStop(0, `rgba(176, 130, 77, ${alpha})`);
        gradient.addColorStop(0.64, `rgba(135, 91, 50, ${alpha * 0.16})`);
        gradient.addColorStop(1, 'rgba(135, 91, 50, 0)');
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(particle.x, particle.y, glowRadius, 0, Math.PI * 2);
        context.fill();
      }

      const idleTime = performance.now() - lastMoveAt;
      const fade = idleTime < 90 ? 1 : clamp(1 - (idleTime - 90) / 420, 0, 1);
      root.style.setProperty('--dh-wake-strength', String(wakeStrength * fade));

      context.restore();
      animationId = window.requestAnimationFrame(draw);
    };

    resize();
    animationId = window.requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('blur', onPointerLeave);

    return () => {
      window.cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('blur', onPointerLeave);
    };
  }, []);

  const handleVideoReady = () => {
    setVideoReady(true);
    setVideoFailed(false);
    const mainVideo = videoRef.current;
    const wakeVideo = wakeVideoRef.current;
    if (mainVideo && wakeVideo && wakeVideo.readyState >= 1) {
      wakeVideo.currentTime = mainVideo.currentTime;
      void wakeVideo.play().catch(() => undefined);
    }
  };

  return (
    <div ref={rootRef} className="dh-backdrop" aria-hidden="true">
      <svg className="dh-filter-definitions" width="0" height="0" aria-hidden="true">
        <filter id="dh-video-sharpen" x="-4%" y="-4%" width="108%" height="108%" colorInterpolationFilters="sRGB">
          <feConvolveMatrix
            order="3"
            kernelMatrix="0 -0.18 0 -0.18 1.72 -0.18 0 -0.18 0"
            divisor="1"
            preserveAlpha="true"
            edgeMode="duplicate"
          />
        </filter>
      </svg>
      <div className={`dh-image-fallback ${videoReady ? 'is-hidden' : ''}`} />
      {!videoFailed && (
        <>
          <video
            ref={videoRef}
            className={`dh-video-bg ${videoReady ? 'is-ready' : ''}`}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            poster="/dunhuang-wallpaper.png"
            disablePictureInPicture
            onCanPlay={handleVideoReady}
            onError={() => {
              setVideoFailed(true);
              setVideoReady(false);
            }}
          >
            <source src="/dunhuang-reference.mp4" type="video/mp4" />
            <source src="/dunhuang-loop.mp4" type="video/mp4" />
          </video>
          <video
            ref={wakeVideoRef}
            className="dh-video-wake"
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            disablePictureInPicture
          >
            <source src="/dunhuang-reference.mp4" type="video/mp4" />
            <source src="/dunhuang-loop.mp4" type="video/mp4" />
          </video>
        </>
      )}
      <canvas ref={canvasRef} className="dh-interaction-canvas" />
      <div className="dh-vignette" />
    </div>
  );
}
