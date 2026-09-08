"use client";

import { useEffect, useRef } from "react";

interface RemoteVideoTileProps {
  stream: MediaStream | undefined;
  name: string;
  videoEnabled: boolean;
  isScreenSharing?: boolean;
}

export default function RemoteVideoTile({ stream, name, videoEnabled, isScreenSharing = false }: RemoteVideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const initials = name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;
    videoElement.srcObject = stream || null;
    return () => { videoElement.srcObject = null; };
  }, [stream]);

  // While this participant is screen sharing, the incoming video IS the
  // screen: render it regardless of their camera on/off state, and contain it
  // (never crop a shared screen to the tile's aspect ratio).
  return <div className="relative w-full h-full bg-[#171d27]">
    {stream && <video ref={videoRef} autoPlay playsInline className={`w-full h-full ${isScreenSharing ? "object-contain" : "object-cover"} ${!videoEnabled && !isScreenSharing ? "opacity-0" : ""}`} />}
    {(!stream || (!videoEnabled && !isScreenSharing)) && <div className="absolute inset-0 flex flex-col items-center justify-center text-white"><div className="w-16 h-16 rounded-full bg-[#6574a8] flex items-center justify-center text-xl font-semibold">{initials}</div><span className="mt-3 text-sm text-slate-300">{name}</span></div>}
  </div>;
}
