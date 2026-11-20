"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, ChevronLeft, ChevronRight, CircleAlert, Clock3, FileCheck2, Filter, HardHat, History, LoaderCircle, Moon, Play, Plus, Radio, RefreshCw, Search, Settings2, ShieldCheck, Sun, Video, Wifi, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, API, useDetector } from "@/hooks/use-detector";
import { Incident, Session, localDate, shortId, timecode, wallTime } from "@/lib/monitoring";
import { AddedCamera, AddCameraDialog, CameraTile, type CameraActivity, type CameraSlot } from "@/components/camera-wall";
import { IncidentReview } from "@/components/incident-review";
import { CameraSettings } from "@/components/camera-settings";
import { RecordingPlayer } from "@/components/recording-player";

type Page = "monitor" | "incidents" | "recordings";
const REVIEW_NAMES = { new: "Needs review", reviewed: "Reviewed", dismissed: "Dismissed" };
const RECORDING_NAMES: Record<string, string> = { ready: "Saved", recording: "Recording", finalizing: "Saving", incomplete: "Needs attention", unavailable: "No video" };

function usePageCapacity(rowHeight: number, reserved = 0) {
  const [capacity, setCapacity] = useState(3);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!node) return;
    const update = () => setCapacity(Math.max(1, Math.min(12, Math.floor((node.clientHeight - reserved) / rowHeight))));
    observer.current = new ResizeObserver(update); observer.current.observe(node); update();
  }, [rowHeight, reserved]);
  useEffect(() => () => observer.current?.disconnect(), []);
  return { ref, capacity };
}

function Pagination({ count, size, page, onChange }: { count: number; size: number; page: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(count / size));
  const current = Math.min(page, pages - 1);
  return <div className="pagination"><span>{count ? `${current * size + 1}–${Math.min((current + 1) * size, count)} of ${count}` : "0 records"}</span><div><Button variant="ghost" size="icon" aria-label="Previous page" disabled={current === 0} onClick={() => onChange(current - 1)}><ChevronLeft /></Button><span>{current + 1} / {pages}</span><Button variant="ghost" size="icon" aria-label="Next page" disabled={current >= pages - 1} onClick={() => onChange(current + 1)}><ChevronRight /></Button></div></div>;
}

function ReviewBadge({ status }: { status: Incident["review_status"] }) { return <span className={`review-badge ${status}`}>{REVIEW_NAMES[status]}</span>; }
function EmptyState({ title, children }: { title: string; children: React.ReactNode }) { return <div className="empty-state"><FileCheck2 size={34} strokeWidth={1.4} aria-hidden="true" /><h3>{title}</h3><p>{children}</p></div>; }

function LiveIncidents({ incidents, sessionIds, onReview, onAll }: { incidents: Incident[]; sessionIds: string[]; onReview: (id: string) => void; onAll: () => void }) {
  const [scope, setScope] = useState("all");
  const [page, setPage] = useState(0);
  const { ref, capacity } = usePageCapacity(122);
  useEffect(() => { if (sessionIds.length) { setScope("current"); setPage(0); } }, [sessionIds.length]);
  const records = scope === "current" && sessionIds.length ? incidents.filter(item => sessionIds.includes(item.session_id)) : incidents;
  const current = Math.min(page, Math.max(0, Math.ceil(records.length / capacity) - 1));
  const shown = records.slice(current * capacity, (current + 1) * capacity);
  return <section className="live-incidents console-panel" aria-labelledby="live-incidents-title"><header className="panel-header"><div><h2 id="live-incidents-title">Recorded incidents</h2><span className="record-count">{records.length}</span></div><button className="text-action" onClick={onAll}>View all<ArrowRight size={17} /></button></header><div className="scope-tabs"><button aria-pressed={scope === "current"} disabled={!sessionIds.length} onClick={() => { setScope("current"); setPage(0); }}>Camera sessions</button><button aria-pressed={scope === "all"} onClick={() => { setScope("all"); setPage(0); }}>All sessions</button></div><div className="live-incident-list" ref={ref}>{shown.length ? shown.map(item => <button key={item.id} className="incident-card" onClick={() => onReview(item.id)} aria-label={`Review incident ${shortId(item.id)}`}><img src={`${API}${item.evidence.best}?v=${item.best_frame}`} alt="Saved incident frame" /><span className="incident-card-body"><span className="incident-card-title">No helmet <span className={`subject-state ${item.state}`}>{item.state === "active" ? "On camera" : "Ended"}</span></span><span className="incident-card-camera">{item.camera} <span>· Person {String(item.track_id).padStart(3, "0")}</span></span><span className="incident-card-bottom"><span className="video-time"><Clock3 size={14} />{timecode(item.first_seen_ms)}</span><ReviewBadge status={item.review_status} /></span></span><ChevronRight size={18} className="incident-card-arrow" aria-hidden="true" /></button>) : <EmptyState title="No incidents recorded">No-helmet incidents will appear here while the camera is running.</EmptyState>}</div><Pagination count={records.length} size={capacity} page={current} onChange={setPage} /></section>;
}

type RegisterProps = { incidents: Incident[]; sessions: Session[]; initialSession: string; onClearSession: () => void; onReview: (id: string) => void };
function IncidentRegister({ incidents, sessions, initialSession, onClearSession, onReview }: RegisterProps) {
  const [query, setQuery] = useState(""); const [review, setReview] = useState("all");
  const [camera, setCamera] = useState("all"); const [date, setDate] = useState("");
  const [filters, setFilters] = useState(false); const [page, setPage] = useState(0);
  const { ref, capacity } = usePageCapacity(84, 52);
  useEffect(() => setPage(0), [query, review, camera, date, initialSession]);
  const rows = useMemo(() => incidents.filter(item => (!query || `${item.id} ${item.camera} ${item.track_id} ${item.notes}`.toLowerCase().includes(query.toLowerCase())) && (review === "all" || item.review_status === review) && (camera === "all" || item.camera === camera) && (!date || localDate(item.started_at) === date) && (!initialSession || item.session_id === initialSession)), [incidents, query, review, camera, date, initialSession]);
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / capacity) - 1));
  const exportCSV = () => {
    const cell = (value: unknown) => { let text = String(value ?? ""); if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"`; };
    const columns = ["Incident ID", "Camera", "Person", "Recorded at", "First seen in video", "Alert in video", "Last seen in video", "Duration seconds", "Entry frame", "Exit frame", "Review", "Notes"];
    const data = rows.map(item => [item.id, item.camera, item.track_id, wallTime(item.started_at, item.first_seen_ms), timecode(item.first_seen_ms, true), timecode(item.confirmed_ms, true), timecode(item.last_seen_ms, true), (item.duration_ms / 1000).toFixed(3), item.entry_frame, item.exit_frame, REVIEW_NAMES[item.review_status], item.notes]);
    const url = URL.createObjectURL(new Blob(["\uFEFF" + [columns, ...data].map(row => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `helmet-watch-incidents-${localDate(new Date().toISOString())}.csv`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="records-workspace console-panel"><header className="records-toolbar"><div className="search-control"><Search size={19} aria-hidden="true" /><input aria-label="Search incidents" placeholder="Search camera, incident or notes" value={query} onChange={event => setQuery(event.target.value)} /></div><select className="control" aria-label="Review status" value={review} onChange={event => setReview(event.target.value)}><option value="all">All statuses</option><option value="new">Needs review</option><option value="reviewed">Reviewed</option><option value="dismissed">Dismissed</option></select><Button variant="outline" aria-expanded={filters} onClick={() => setFilters(value => !value)}><Filter />Filters</Button><Button variant="outline" disabled={!rows.length} onClick={exportCSV}><ArrowDownToLine />Export CSV</Button></header>
    {filters && <div className="extra-filters"><label>Camera<select className="control" value={camera} onChange={event => setCamera(event.target.value)}><option value="all">All cameras</option>{[...new Set(sessions.map(item => item.camera))].map(name => <option key={name}>{name}</option>)}</select></label><label>Recording date<input className="control" type="date" value={date} onChange={event => setDate(event.target.value)} /></label><Button variant="ghost" onClick={() => { setCamera("all"); setDate(""); }}>Clear filters</Button></div>}
    {initialSession && <div className="session-filter">Showing recording {shortId(initialSession)}<button onClick={onClearSession}>Show all recordings</button></div>}
    <div className="records-table-area" ref={ref}>{rows.length ? <table className="records-table incident-table"><thead><tr><th>Incident</th><th>Camera / person</th><th>First seen in video</th><th>Last seen in video</th><th>Status</th><th><span className="sr-only">Action</span></th></tr></thead><tbody>{rows.slice(current * capacity, (current + 1) * capacity).map(item => <tr key={item.id}><td><button className="table-incident" onClick={() => onReview(item.id)}><img src={`${API}${item.evidence.best}?v=${item.best_frame}`} alt="Incident evidence" /><span><strong>No helmet</strong><small>{shortId(item.id)}</small></span></button></td><td><strong>{item.camera}</strong><small>Person {String(item.track_id).padStart(3, "0")}</small></td><td><strong className="video-time">{timecode(item.first_seen_ms, true)}</strong><small>{localDate(item.started_at)}</small></td><td><strong className="video-time">{timecode(item.last_seen_ms, true)}</strong><small>{item.state === "active" ? "Still on camera" : `${(item.duration_ms / 1000).toFixed(1)} seconds in view`}</small></td><td><ReviewBadge status={item.review_status} /></td><td><Button variant="ghost" onClick={() => onReview(item.id)}>Review<ChevronRight /></Button></td></tr>)}</tbody></table> : <EmptyState title={incidents.length ? "No matching incidents" : "No incidents recorded"}>{incidents.length ? "Try a different search or filter." : "Incidents recorded during monitoring will be listed here."}</EmptyState>}</div><Pagination count={rows.length} size={capacity} page={current} onChange={setPage} />
  </section>;
}

function Recordings({ sessions, onPlay, onIncidents, onRecover, recovery, lockedSessions }: { sessions: Session[]; onPlay: (session: Session) => void; onIncidents: (id: string) => void; onRecover: (session: Session) => void; recovery: string; lockedSessions: Set<string> }) {
  const [query, setQuery] = useState(""); const [date, setDate] = useState(""); const [page, setPage] = useState(0);
  const { ref, capacity } = usePageCapacity(84, 52);
  useEffect(() => setPage(0), [query, date]);
  const rows = sessions.filter(item => (!query || `${item.camera} ${item.id}`.toLowerCase().includes(query.toLowerCase())) && (!date || localDate(item.started_at) === date));
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / capacity) - 1));
  return <section className="records-workspace console-panel"><header className="records-toolbar"><div className="search-control"><Search size={19} aria-hidden="true" /><input aria-label="Search recordings" placeholder="Search camera or recording" value={query} onChange={event => setQuery(event.target.value)} /></div><label className="recording-date">Date<input className="control" type="date" aria-label="Recording date" value={date} onChange={event => setDate(event.target.value)} /></label>{date && <Button variant="ghost" onClick={() => setDate("")}>Clear</Button>}<span className="toolbar-count">{rows.length} recordings</span></header><div className="records-table-area" ref={ref}>{rows.length ? <table className="records-table sessions-table"><thead><tr><th>Camera</th><th>Recorded</th><th>Length</th><th>Incidents</th><th>Status</th><th>Actions</th></tr></thead><tbody>{rows.slice(current * capacity, (current + 1) * capacity).map(session => <tr key={session.id}><td><div className="camera-cell"><span className="table-camera-icon"><Video size={22} /></span><span><strong>{session.camera}</strong><small>{shortId(session.id)}</small></span></div></td><td><strong>{new Date(session.started_at).toLocaleDateString()}</strong><small>{new Date(session.started_at).toLocaleTimeString()}</small></td><td className="video-time">{timecode(session.duration_ms)}</td><td><button className="incident-count-link" onClick={() => onIncidents(session.id)}>{session.incident_count} incidents<ChevronRight size={16} /></button></td><td><span className={`recording-badge ${session.recording_status}`}><i />{RECORDING_NAMES[session.recording_status] || "Unavailable"}</span></td><td><div className="recording-row-actions">{session.recording_status === "ready" ? <><Button variant="outline" onClick={() => onPlay(session)}><Play />Play</Button><Button variant="ghost" size="icon" asChild><a href={`${API}/api/sessions/${session.id}/video?download=true`} aria-label={`Download recording ${shortId(session.id)}`}><ArrowDownToLine /></a></Button></> : session.recording_status === "incomplete" && session.chunks > 0 ? <Button variant="outline" disabled={!!recovery || lockedSessions.has(session.id)} onClick={() => onRecover(session)}>{recovery === session.id ? <LoaderCircle className="spin" /> : <RefreshCw />}Recover</Button> : <span className="muted-text">{session.recording_status === "recording" ? "Stop to watch" : "No video available"}</span>}</div></td></tr>)}</tbody></table> : <EmptyState title={sessions.length ? "No matching recordings" : "No recordings yet"}>{sessions.length ? "Try another camera name or date." : "Start monitoring, then stop and save to watch a recording here."}</EmptyState>}</div><Pagination count={rows.length} size={capacity} page={current} onChange={setPage} /></section>;
}

export function DetectionWorkspace() {
  const [claimed] = useState(() => new Set<string>());
  const [primaryModel, setPrimaryModel] = useState("default");
  const d = useDetector({ claimed, model: primaryModel });
  const [slots, setSlots] = useState<CameraSlot[]>([]);
  const [videoFiles, setVideoFiles] = useState<Record<string, File>>({});
  const [activity, setActivity] = useState<Record<string, CameraActivity>>({});
  const [addCamera, setAddCamera] = useState(false);
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const { setCamera, setCameraName } = d;
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("helmet-watch-cameras") || "null");
      if (saved && Array.isArray(saved.slots)) {
        setSlots(saved.slots.filter((slot: CameraSlot | null) => slot && typeof slot.deviceId === "string" && slot.deviceId && typeof slot.name === "string"));
        if (typeof saved.camera === "string") setCamera(saved.camera);
        if (typeof saved.name === "string") setCameraName(saved.name);
        if (typeof saved.model === "string" && saved.model) setPrimaryModel(saved.model);
      }
    } catch {}
    setWorkspaceLoaded(true);
  }, [setCamera, setCameraName]);
  useEffect(() => {
    if (!workspaceLoaded) return;
    try { localStorage.setItem("helmet-watch-cameras", JSON.stringify({ slots, camera: d.camera, name: d.cameraName, model: primaryModel })); } catch {}
  }, [slots, d.camera, d.cameraName, primaryModel, workspaceLoaded]);
  const report = useCallback((deviceId: string, state: CameraActivity) => {
    setActivity(current => ({ ...current, [deviceId]: state }));
  }, []);
  const [page, setPage] = useState<Page>("monitor"); const [settings, setSettings] = useState(false);
  const [mobileView, setMobileView] = useState<"camera" | "incidents">("camera");
  const [theme, setTheme] = useState("dark"); const [now, setNow] = useState<Date | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]); const [sessions, setSessions] = useState<Session[]>([]);
  const [loadError, setLoadError] = useState(""); const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null); const [playing, setPlaying] = useState<Session | null>(null);
  const [sessionFilter, setSessionFilter] = useState(""); const [recovery, setRecovery] = useState("");
  const [retention, setRetention] = useState<number | null>(null); const [recoveryError, setRecoveryError] = useState("");
  const inFlight = useRef(false);
  useEffect(() => { setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark"); setNow(new Date()); const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  const toggleTheme = () => { const next = theme === "dark" ? "light" : "dark"; setTheme(next); document.documentElement.dataset.theme = next; try { localStorage.setItem("helmet-watch-theme", next); } catch {} };
  const refresh = useCallback(async () => {
    if (inFlight.current) return; inFlight.current = true;
    try { const [events, runs] = await Promise.all([api<Incident[]>("/api/incidents"), api<Session[]>("/api/sessions")]); setIncidents(events); setSessions(runs); setLoadError(""); setLastUpdated(new Date()); }
    catch { setLoadError("Saved records are unavailable. Check the connection and try again."); }
    finally { inFlight.current = false; }
  }, []);
  useEffect(() => { void refresh(); void api<{ retention_days: number }>("/api/monitoring").then(body => setRetention(body.retention_days)).catch(() => undefined); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { if (d.phase === "idle" && d.sessionId) void refresh(); }, [d.phase, d.sessionId, refresh]);
  const addedIds = new Set(slots.filter(slot => slot.kind !== "video").map(slot => slot.deviceId));
  const excluded = new Set(addedIds);
  const primarySource = d.camera || d.cameras.find(device => device.deviceId !== "default")?.deviceId;
  if (primarySource) excluded.add(primarySource);
  const cameraActivity = [{ phase: d.phase, sessionId: d.sessionId, needsSave: !!d.saveError }, ...Object.values(activity)];
  const lockedSessions = new Set(cameraActivity.filter(camera => camera.phase !== "idle" || camera.needsSave).map(camera => camera.sessionId));
  const sessionIds = cameraActivity.map(camera => camera.sessionId).filter(Boolean);
  const hasRecording = cameraActivity.some(camera => camera.phase !== "idle");
  const needsSave = cameraActivity.some(camera => camera.needsSave);
  const selected = incidents.find(item => item.id === selectedId) || null;
  const unreviewed = incidents.filter(item => item.review_status === "new").length;
  const viewSessionIncidents = (id: string) => { setSessionFilter(id); setPage("incidents"); };
  const recoverSession = async (session: Session) => {
    setRecovery(session.id); setRecoveryError("");
    try { await api(`/api/sessions/${session.id}/finish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chunks: session.chunks, duration_ms: session.duration_ms }), signal: AbortSignal.timeout(120000) }); await refresh(); }
    catch { setRecoveryError("The recording could not be recovered. Its saved incident photos are still available."); }
    finally { setRecovery(""); }
  };
  return <div className="control-room">
    <aside className="sidebar"><a className="brand" href="/" aria-label="Helmet Watch home"><span className="brand-mark"><HardHat size={26} strokeWidth={1.8} /></span><span className="brand-name">Helmet<span>Watch</span></span></a><div className="station-label"><span className="station-dot" />Traffic enforcement</div><nav aria-label="Main navigation">{([{ id: "monitor", name: "Live monitor", icon: Radio }, { id: "incidents", name: "Incidents", icon: FileCheck2 }, { id: "recordings", name: "Recordings", icon: History }] as const).map(item => <button key={item.id} className={page === item.id ? "selected" : ""} aria-current={page === item.id ? "page" : undefined} aria-label={item.name} onClick={() => setPage(item.id)}><item.icon size={21} /><span>{item.name}</span>{item.id === "incidents" && unreviewed > 0 && <b>{unreviewed}</b>}</button>)}</nav><div className="sidebar-bottom"><button className="sidebar-action" onClick={() => setSettings(true)} aria-label="Camera settings"><Settings2 size={21} /><span>Camera settings</span></button><button className="sidebar-action" onClick={toggleTheme} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>{theme === "dark" ? <Sun size={21} /> : <Moon size={21} />}<span>{theme === "dark" ? "Light mode" : "Dark mode"}</span></button><div className="local-station"><ShieldCheck size={21} /><span>Local station<small>Saved on this computer</small></span></div></div></aside>
    <main className="console-main"><header className="workspace-header"><div><div className="workspace-location">Traffic enforcement <ChevronRight size={14} /><span>{page === "monitor" ? "Camera view" : "Saved records"}</span></div><h1>{page === "monitor" ? "Live monitoring" : page === "incidents" ? "Incident register" : "Recordings"}</h1></div><div className="header-tools"><div className="station-clock"><strong>{now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "—"}</strong><span>{now ? now.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "Local time"}</span></div><span className={`connection-state ${d.health ? "online" : "offline"}`}>{d.health ? <Wifi size={17} /> : <WifiOff size={17} />}{d.health ? "Connected" : d.checking ? "Connecting" : "Offline"}</span><Button variant="outline" size="icon" aria-label="Refresh connection and records" onClick={() => { void d.checkHealth(); void refresh(); }}><RefreshCw className={d.checking ? "spin" : ""} /></Button></div></header>
      {(loadError || recoveryError) && <div className="notice-bar error" role="alert"><CircleAlert size={20} /><span>{recoveryError || loadError}</span>{loadError && <Button variant="ghost" onClick={() => void refresh()}>Retry</Button>}</div>}
      {page !== "monitor" && (hasRecording || needsSave) && <div className="notice-bar recording-notice" role="status"><span className="record-dot" /><span>{needsSave ? "A camera recording needs attention." : "Camera sessions are in progress."}</span><Button variant="ghost" onClick={() => setPage("monitor")}>Back to cameras<ArrowRight /></Button></div>}
      <div className={`console-body ${page === "monitor" ? "show-monitor" : "show-records"}`}>
        {page === "monitor" && <div className="mobile-live-tabs"><button aria-pressed={mobileView === "camera"} onClick={() => setMobileView("camera")}><Video size={18} />Cameras</button><button aria-pressed={mobileView === "incidents"} onClick={() => setMobileView("incidents")}><FileCheck2 size={18} />Incidents <span>{incidents.length}</span></button></div>}
        {/* Keep the video mounted so navigating between views does not interrupt recording. */}
        <div className={`live-layout mobile-show-${mobileView} ${page !== "monitor" ? "hidden-view" : ""}`}>
          <section className="camera-wall" aria-labelledby="camera-wall-title">
            <header className="camera-wall-toolbar">
              <h2 id="camera-wall-title">Cameras <span>{slots.length + 1}</span></h2>
              <Button variant="outline" onClick={() => setAddCamera(true)}><Plus size={18} aria-hidden="true" />Add camera</Button>
            </header>
            <div className={`camera-wall-feeds ${slots.length ? "has-multiple-cameras" : ""}`}>
              <CameraTile detector={d} onSettings={() => setSettings(true)} />
              {slots.map(slot => (
                <AddedCamera key={slot.deviceId} slot={slot} claimed={claimed} report={report}
                  unavailable={slot.kind !== "video" && d.cameras.length > 0 && !d.cameras.some(device => device.deviceId === slot.deviceId)}
                  file={videoFiles[slot.deviceId]}
                  onSelectVideo={file => setVideoFiles(current => ({ ...current, [slot.deviceId]: file }))}
                  onRemove={() => {
                    setSlots(current => current.filter(item => item.deviceId !== slot.deviceId));
                    setActivity(({ [slot.deviceId]: removed, ...remaining }) => remaining);
                    if (slot.kind === "video") setVideoFiles(({ [slot.deviceId]: removed, ...remaining }) => remaining);
                  }} />
              ))}
            </div>
          </section>
          <LiveIncidents incidents={incidents} sessionIds={sessionIds} onReview={setSelectedId} onAll={() => { setSessionFilter(""); setPage("incidents"); }} />
        </div>
        {page === "incidents" && <IncidentRegister incidents={incidents} sessions={sessions} initialSession={sessionFilter} onClearSession={() => setSessionFilter("")} onReview={setSelectedId} />}
        {page === "recordings" && <Recordings sessions={sessions} onPlay={setPlaying} onIncidents={viewSessionIncidents} onRecover={session => void recoverSession(session)} recovery={recovery} lockedSessions={lockedSessions} />}
      </div><footer className="console-statusbar"><span><i className={!loadError && lastUpdated ? "online" : ""} />{loadError ? "Records disconnected" : lastUpdated ? `Records updated ${lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}` : "Loading saved records"}</span><span>{page === "monitor" ? `${unreviewed} incidents need review` : `${incidents.length} incidents · ${sessions.length} recordings`}</span></footer>
    </main>
    <CameraSettings open={settings} onClose={() => setSettings(false)} detector={d} model={primaryModel} onModelChange={setPrimaryModel} retention={retention} excluded={addedIds} />
    {addCamera && <AddCameraDialog detector={d} excluded={excluded} onClose={() => setAddCamera(false)} onAdd={(slot, file) => {
      setSlots(current => current.some(item => item.deviceId === slot.deviceId) ? current : [...current, slot]);
      if (file) setVideoFiles(current => ({ ...current, [slot.deviceId]: file }));
      setAddCamera(false);
    }} />}<IncidentReview incident={selected} onClose={() => setSelectedId(null)} onUpdate={() => void refresh()} /><RecordingPlayer session={playing} onClose={() => setPlaying(null)} onIncidents={viewSessionIncidents} />
  </div>;
}
