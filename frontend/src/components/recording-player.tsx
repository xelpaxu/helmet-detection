"use client";
import { useEffect, useRef } from "react";
import { Download, Film, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { API } from "@/hooks/use-detector";
import { Session, shortId, timecode, wallTime } from "@/lib/monitoring";

export function RecordingPlayer({ session, onClose, onIncidents }: { session: Session | null; onClose: () => void; onIncidents: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (session) dialog.current?.showModal(); else dialog.current?.close(); }, [session?.id]);
  return <dialog ref={dialog} className="recording-dialog" aria-labelledby="recording-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    {session && <><header className="dialog-header"><div><Film size={22} aria-hidden="true" /><h2 id="recording-title">{session.camera}</h2></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close recording"><X /></Button></header><div className="recording-player-content"><video src={`${API}/api/sessions/${session.id}/video`} controls preload="metadata" aria-label="Saved session recording" /><div className="recording-facts"><div><span>Recorded</span><strong>{wallTime(session.started_at)}</strong></div><div><span>Length</span><strong>{timecode(session.duration_ms)}</strong></div><div><span>Incidents</span><strong>{session.incident_count}</strong></div><div><span>Recording ID</span><strong>{shortId(session.id)}</strong></div></div></div><footer className="dialog-footer"><Button variant="outline" onClick={() => { onIncidents(session.id); onClose(); }}>View incidents</Button><Button asChild><a href={`${API}/api/sessions/${session.id}/video?download=true`}><Download />Download video</a></Button></footer></>}
  </dialog>;
}
