"use client";

import { useEffect, useRef, type MutableRefObject } from "react";

interface LocalVideoTileProps {
  stream: MediaStream | null;
  streamRef?: MutableRefObject<MediaStream | null>;
  displayStream?: MediaStream | null;
  name: string;
  videoEnabled: boolean;
  isSharing?: boolean;
}

export default function LocalVideoTile({ stream, streamRef, displayStream, name, videoEnabled, isSharing = false }: LocalVideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeStream = displayStream || stream || streamRef?.current || null;
  const initials = name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;
    videoElement.srcObject = activeStream || null;
    return () => {
      videoElement.srcObject = null;
    };
  }, [activeStream]);

  return <div className="relative w-full h-full bg-[#253146]">
    {activeStream && <video ref={videoRef} autoPlay playsInline muted className={`w-full h-full ${isSharing ? "object-contain" : "object-cover -scale-x-100"} ${!videoEnabled && !isSharing ? "opacity-0" : ""}`} />}
    {(!videoEnabled || !activeStream) && !isSharing && <div className="absolute inset-0 flex flex-col items-center justify-center text-white"><div className="w-20 h-20 rounded-full bg-[#b96e3d] flex items-center justify-center text-2xl font-semibold">{initials}</div><span className="mt-3 text-sm text-slate-300">{name}</span></div>}
  </div>;
}
