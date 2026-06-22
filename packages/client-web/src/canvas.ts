import Konva from "konva";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  addConnector,
  addObject,
  addStroke,
  cloneObject,
  addStamp,
  CONNECTOR_SIDES,
  DEFAULT_CONNECTOR_COLOR,
  DEFAULT_CONNECTOR_WIDTH,
  DEFAULT_SHAPE_FILL,
  DEFAULT_STAMP_SIZE,
  DEFAULT_STICKY_COLOR,
  defaultCapsFor,
  deleteObjects,
  objectsMap,
  orderArray,
  randomId,
  readObject,
  readUserProfile,
  setConnectorEnds,
  setConnectorStyle,
  setObjectsPoints,
  sideMidpoint,
  translateObjects,
  type BoardObject,
  type ConnectorCap,
  type ConnectorEnd,
  type ConnectorKind,
  type ConnectorObject,
  type PresenceState,
  type ShapeKind,
  type StrokeObject,
  type StrokeStyle,
} from "@coboard/shared";
import { ViewportController } from "./viewport";
import { TextLayer } from "./text-layer";
import { ConnectorBar } from "./connector-bar";
import { ROTATE_CURSORS, type RotateCorner } from "./cursors";

export type ToolId = "select" | "hand" | "pen" | "eraser" | "stamp" | "text" | "sticky" | "shapes";

export interface CanvasOptions {
  container: HTMLElement;
  doc: Y.Doc;
  awareness: Awareness;
  user: PresenceState;
  /** Ask the host to switch tools (updates the dock highlight) — e.g. revert to select after a
   *  text/sticky box is placed + finished. */
  requestTool?: (tool: ToolId) => void;
  /** Fired after a stroke is drawn or a sticky/shape is placed — the host collapses the mobile
   *  mini-sheet so the canvas reclaims space. */
  onPlaced?: () => void;
  /** Fired after a stamp is placed, with its src — the host can bump the emoji recents. */
  onStampPlaced?: (src: string) => void;
}

const CURSOR_HZ = 30;
const LERP = 0.3;
const SELECT_BLUE = "#4a9eff";
// Konva attr that tags a rendered node with its object id (the select tool's hit→id contract).
// One const so the writer (renderObjects) and reader (objIdOf) can't drift on a string literal.
const OBJ_ID_ATTR = "objId";
// arrow pointer (Lucide mouse-pointer-2): used for the local CSS cursor
// (black fill, white edge) AND remote presence cursors (filled in each user's colour).
const CURSOR_PATH =
  "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z";
const CURSOR_URL = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#1e1e1e" stroke="#ffffff" stroke-width="1.75" stroke-linejoin="round"><path d="${CURSOR_PATH}"/></svg>`,
)}") 4 4, auto`;
// Pen tool: a pen cursor matching the toolbar icon, hotspot at the writing tip (2,22).
const PEN_CURSOR_URL = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#ffffff" stroke="#1e1e1e" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`,
)}") 2 22, auto`;
// Eraser tool: a solid eraser glyph as the cursor (source: src/assets/eraser.svg), white-filled with a
// dark outline so it reads on both light and dark canvases; hotspot near its lower-left erasing corner.
const ERASER_CURSOR_URL = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 32 32" fill="#ffffff" stroke="#1e1e1e" stroke-width="1.5" stroke-linejoin="round"><path d="M29.061 9.29 22.71 2.939a3 3 0 0 0-4.242 0L2.939 18.468a3 3 0 0 0 0 4.242l6.351 6.351a3 3 0 0 0 4.242 0l15.529-15.529a3 3 0 0 0 0-4.242ZM12.118 27.647a1 1 0 0 1-1.414 0L4.353 21.3a1 1 0 0 1 0-1.414l4.558-4.557 7.764 7.764Zm15.529-15.529-9.558 9.557-7.764-7.764 9.557-9.558a1 1 0 0 1 1.414 0l6.351 6.347a1 1 0 0 1 0 1.418Z"/></svg>`,
)}") 6 18, auto`;
// Stamp tool: the stamp glyph (toolbar icon), white-filled with a dark outline, hotspot centred on
// the drop point so the translucent ghost preview lands where you click.
const STAMP_CURSOR_URL = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="-4 -4 32 32"><g transform="rotate(18 12 12)"><g fill="#ffffff" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"><path d="M20.809,16.492c0.146,-0.802 -0.072,-1.628 -0.594,-2.254c-0.523,-0.626 -1.296,-0.988 -2.111,-0.988l-12.208,-0c-0.815,0 -1.588,0.362 -2.111,0.988c-0.522,0.626 -0.74,1.452 -0.594,2.254c0.188,1.036 0.39,2.149 0.496,2.732c0.109,0.594 0.626,1.026 1.23,1.026l14.166,-0c0.604,-0 1.121,-0.432 1.23,-1.026l0.496,-2.732Zm-1.935,2.258l-13.748,0l-0.459,-2.526c-0.067,-0.365 0.032,-0.74 0.27,-1.025c0.237,-0.284 0.589,-0.449 0.959,-0.449c0,-0 12.208,-0 12.208,-0c0.37,0 0.722,0.165 0.959,0.449c0.238,0.285 0.337,0.66 0.27,1.025l-0.459,2.526Z"/><path d="M19.235 19.647c.045-.22-.012-.449-.155-.622-.142-.174-.355-.275-.58-.275l-13 0c-.225 0-.438.101-.58.275-.143.173-.2.402-.155.622l.339 1.693c.163.818.882 1.407 1.716 1.407 2.191 0 8.169 0 10.36 0 .834 0 1.553-.589 1.716-1.407l.339-1.693zm-1.65.603l-.159.796c-.024.117-.126.201-.246.201l-10.36 0c-.12 0-.222-.084-.246-.201 0 0-.159-.796-.159-.796l11.17 0zM8.298 13.736c-.087.23-.055.488.085.691.14.202.371.323.617.323l6 0c.246 0 .477-.121.617-.323.14-.203.172-.461.085-.691 0 0-1.005-2.633-.013-4.94.407-.947 1.048-2.079 1.372-3.136.267-.872.32-1.705.03-2.405-.257-.618-.771-1.165-1.715-1.53-.763-.295-1.853-.478-3.376-.475-1.523-.003-2.613.18-3.376.475-.944.365-1.458.912-1.715 1.53-.29.7-.237 1.533.03 2.405.324 1.057.965 2.189 1.372 3.136.992 2.307-.013 4.94-.013 4.94zm1.687-.486c.261-1.178.499-3.197-.296-5.046-.388-.903-1.007-1.977-1.316-2.984-.155-.505-.246-.985-.078-1.39.125-.302.409-.528.869-.706.64-.247 1.558-.376 2.835-.374.001 0 .001 0 .002 0 1.277-.002 2.195.127 2.835.374.46.178.744.404.869.706.168.405.077.885-.078 1.39-.309 1.007-.928 2.081-1.316 2.984-.795 1.849-.557 3.868-.296 5.046l-4.03 0z"/></g><g fill="#1e1e1e" fill-rule="evenodd"><path d="M20.809,16.492c0.146,-0.802 -0.072,-1.628 -0.594,-2.254c-0.523,-0.626 -1.296,-0.988 -2.111,-0.988l-12.208,-0c-0.815,0 -1.588,0.362 -2.111,0.988c-0.522,0.626 -0.74,1.452 -0.594,2.254c0.188,1.036 0.39,2.149 0.496,2.732c0.109,0.594 0.626,1.026 1.23,1.026l14.166,-0c0.604,-0 1.121,-0.432 1.23,-1.026l0.496,-2.732Zm-1.935,2.258l-13.748,0l-0.459,-2.526c-0.067,-0.365 0.032,-0.74 0.27,-1.025c0.237,-0.284 0.589,-0.449 0.959,-0.449c0,-0 12.208,-0 12.208,-0c0.37,0 0.722,0.165 0.959,0.449c0.238,0.285 0.337,0.66 0.27,1.025l-0.459,2.526Z"/><path d="M19.235 19.647c.045-.22-.012-.449-.155-.622-.142-.174-.355-.275-.58-.275l-13 0c-.225 0-.438.101-.58.275-.143.173-.2.402-.155.622l.339 1.693c.163.818.882 1.407 1.716 1.407 2.191 0 8.169 0 10.36 0 .834 0 1.553-.589 1.716-1.407l.339-1.693zm-1.65.603l-.159.796c-.024.117-.126.201-.246.201l-10.36 0c-.12 0-.222-.084-.246-.201 0 0-.159-.796-.159-.796l11.17 0zM8.298 13.736c-.087.23-.055.488.085.691.14.202.371.323.617.323l6 0c.246 0 .477-.121.617-.323.14-.203.172-.461.085-.691 0 0-1.005-2.633-.013-4.94.407-.947 1.048-2.079 1.372-3.136.267-.872.32-1.705.03-2.405-.257-.618-.771-1.165-1.715-1.53-.763-.295-1.853-.478-3.376-.475-1.523-.003-2.613.18-3.376.475-.944.365-1.458.912-1.715 1.53-.29.7-.237 1.533.03 2.405.324 1.057.965 2.189 1.372 3.136.992 2.307-.013 4.94-.013 4.94zm1.687-.486c.261-1.178.499-3.197-.296-5.046-.388-.903-1.007-1.977-1.316-2.984-.155-.505-.246-.985-.078-1.39.125-.302.409-.528.869-.706.64-.247 1.558-.376 2.835-.374.001 0 .001 0 .002 0 1.277-.002 2.195.127 2.835.374.46.178.744.404.869.706.168.405.077.885-.078 1.39-.309 1.007-.928 2.081-1.316 2.984-.795 1.849-.557 3.868-.296 5.046l-4.03 0z"/></g></g></svg>`,
)}") 15 15, auto`;
// The rotate cursor lives in ./cursors (shared per-corner ROTATE_CURSORS — same one the HTML boxes use).
const ERASER_GHOST_W = 12; // eraser ghost-trail width on screen (px)
const ERASER_TAIL_MS = 450; // a swept ghost point lingers ~450 ms, then the trail shrinks + fades away
const ERASER_UNDO_MERGE_MS = 60_000; // during one swipe, merge every live delete into a single undo step

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Whether point `p` lies inside `r`, expanded by `pad` on every side. */
function pointInRect(p: { x: number; y: number }, r: Rect, pad = 0): boolean {
  return (
    p.x >= r.x - pad &&
    p.x <= r.x + r.width + pad &&
    p.y >= r.y - pad &&
    p.y <= r.y + r.height + pad
  );
}

/** A *remote* peer's in-progress stroke, streamed over awareness while they draw. */
interface DrawState {
  id: string;
  points: number[];
  color: string;
  width: number;
  style: StrokeStyle;
  opacity: number;
}

const MAX_PREVIEW_VERTS = 128; // cap broadcast live-stroke vertices (cost); the committed stroke is full-res
/** Stride a flat [x,y,…] list down to ≤ maxVerts vertices, always keeping the last (the pen tip). */
function downsamplePoints(pts: number[], maxVerts: number): number[] {
  const verts = pts.length >> 1;
  if (verts <= maxVerts) return pts;
  const stride = Math.ceil(verts / maxVerts);
  const out: number[] = [];
  for (let i = 0; i < verts; i += stride) out.push(pts[i * 2] as number, pts[i * 2 + 1] as number);
  const lx = pts[pts.length - 2] as number;
  const ly = pts[pts.length - 1] as number;
  if (out[out.length - 2] !== lx || out[out.length - 1] !== ly) out.push(lx, ly);
  return out;
}

/**
 * BoardCanvas — renders the room's Yjs document with Konva and drives M1
 * interaction: infinite pan/zoom (the dot grid tracks the camera), a freehand
 * pen (color/width/style/opacity) that writes strokes into the single shared
 * doc, live labeled cursors, and a **select** tool (marquee +
 * click select, a transform box with corner handles, drag-to-move and resize).
 */
export class BoardCanvas {
  private readonly stage: Konva.Stage;
  private readonly content = new Konva.Layer();
  private readonly overlay = new Konva.Layer();
  /** Top layer for selection chrome (marquee + transform box) — never wiped by renderObjects. */
  private readonly uiLayer = new Konva.Layer();
  /** Light-blue per-node outlines drawn under the union transform box for multi-selections. */
  private readonly highlightGroup = new Konva.Group({ listening: false });
  private readonly objects: Y.Map<Y.Map<unknown>>;
  private readonly cursors = new Map<number, Konva.Group>();
  private readonly cursorTargets = new Map<number, { x: number; y: number }>();
  /** Remote cursors render in their own stage whose container sits ABOVE the HTML text overlay, so a
   *  cursor is never painted under a text box (all main-stage Konva layers live below the overlay).
   *  It mirrors the main camera transform (syncCursorStage) so world-space cursors still line up. */
  private cursorStage!: Konva.Stage;
  private readonly cursorLayer = new Konva.Layer({ listening: false });
  /** Colored outlines showing what each *remote* peer has selected (drawn in their cursor color). */
  private readonly remoteSelections = new Konva.Group({ listening: false });
  /** Outline rects reused across renders, keyed `clientId:objId` — avoids per-frame Konva churn
   *  while a peer's selection glides during an interpolated drag/resize. */
  private readonly remoteSelRects = new Map<string, Konva.Rect>();
  /** One group box per peer (keyed by clientId) drawn around a peer's multi-node selection, in their
   *  colour — mirrors the local group/transform box so others see the grouping in realtime. */
  private readonly remoteSelGroupRects = new Map<number, Konva.Rect>();
  /** Floating tooltip (avatar + name) shown when hovering another user's selection on the canvas. */
  private peerTip: HTMLElement | null = null;
  /** Live map of object id → its rendered Konva node (rebuilt every render). */
  private readonly nodeById = new Map<string, Konva.Line>();
  /** The stamp the next canvas tap places (`mark:<name>` | `emoji:<codepoint>`), or null. */
  private currentStamp: string | null = null;
  /** Translucent placement preview of the armed stamp, tracking the cursor (overlay layer). */
  private stampGhost: Konva.Image | null = null;
  private stampGhostSrc: string | null = null;
  /** Random ±15° tilt previewed by the ghost — placed stamps land at exactly this angle. */
  private stampGhostRot = 0;
  /** Decoded stamp images keyed by url — re-arming a used stamp swaps instantly (no reload flash). */
  private readonly stampImgCache = new Map<string, HTMLImageElement | HTMLCanvasElement>();
  private readonly selected = new Set<string>();
  /** Local copy/paste buffer (in-app, not the system clipboard): a snapshot of the objects copied
   *  with ⌘/Ctrl+C; ⌘/Ctrl+V clones them with a cascading offset. */
  private clipboard: BoardObject[] = [];
  private pasteCount = 0; // cascade-offset multiplier for repeated paste of the same clipboard
  /** Connectors (lines/arrows) render in their own layer (above strokes, below the overlay + the
   *  HTML shape layer) so they re-route independently of the delicate stroke render path. */
  private readonly connectorLayer = new Konva.Layer();
  /** Each connector is a Konva group (shaft Line + start/end cap shapes), so any cap combo renders. */
  private readonly connectorNodes = new Map<string, Konva.Group>();
  /** shapeId → ids of connectors with an end bound to it (for live re-routing during a shape drag). */
  private readonly connectorsByShape = new Map<string, Set<string>>();
  private readonly selectedConnectors = new Set<string>();
  /** Chrome for a single selected connector: the two draggable endpoint handles (HTML, screen-space)
   *  + the in-progress endpoint drag. */
  private connectorHandlesEl: HTMLDivElement | null = null;
  private connectorEndDrag: { id: string; which: "from" | "to" } | null = null;
  /** In-progress body move of the selected connector(s): the grab point + each one's start RESOLVED
   *  endpoints (the move is rigid — dragging the body detaches bound ends so it can reposition). */
  private connectorMove: {
    startX: number;
    startY: number;
    origins: Map<
      string,
      { a: { x: number; y: number }; b: { x: number; y: number }; conn: ConnectorObject }
    >;
    moved: boolean;
  } | null = null;
  private lastConnectorSent = 0;
  /** Peers' in-progress connector edits (ephemeral, from awareness). Each is drawn between glided
   *  endpoints (`ca`/`cb` interpolate toward the broadcast targets `ta`/`tb`) so a 30 Hz stream still
   *  looks smooth; the committed copy is hidden for ids in `remoteConnectorIds` (no double-draw). */
  private readonly remoteConn = new Map<
    number,
    {
      group: Konva.Group;
      conn: ConnectorObject;
      ta: { x: number; y: number };
      tb: { x: number; y: number };
      ca: { x: number; y: number };
      cb: { x: number; y: number };
    }
  >();
  private connGlideRaf = 0;
  private readonly remoteConnectorIds = new Set<string>();
  /** Connector id → colour of the peer who has it selected (drives the peer-selection tint). */
  private readonly remoteConnSel = new Map<string, string>();
  /** The edit bar shown above a single selected connector (colour / weight / style / caps). */
  private readonly connectorBar: ConnectorBar;
  /** The connector kind the shapes tool draws (set when a line/arrow menu item is picked); null =
   *  the tool places shape boxes instead. */
  private currentConnector: ConnectorKind | null = null;
  /** In-progress connector draw: its id, resolved start end, and the live-preview group. */
  private drawingConnector: { id: string; from: ConnectorEnd; node: Konva.Group } | null = null;
  /** Local edit history (objects + z-order). Remote edits keep a different origin, so undo only reverts *your* changes. */
  private readonly undoManager: Y.UndoManager;
  /** Camera: owns the stage transform (pan/zoom), wheel, grid, and zoom readout. */
  private readonly viewport: ViewportController;
  /** HTML overlay that renders + edits text objects (kept out of the Konva scene). */
  private readonly textLayer: TextLayer;

  private tool: ToolId = "select";
  /** Eraser gesture: objects are deleted from the doc LIVE as the path crosses them (so peers see the
   *  erasure in realtime); the whole swipe merges into ONE undo step via a raised UndoManager
   *  captureTimeout. The faint ghost trail is a separate, self-fading overlay (eraserTail). */
  private erasing = false;
  private lastErasePoint: { x: number; y: number } | null = null;
  private eraserTail: { ghost: Konva.Line; trail: { x: number; y: number; t: number }[] } | null =
    null;
  private eraserRaf = 0;
  private color = "#0e1116";
  private stickyColor: string = DEFAULT_STICKY_COLOR;
  /** The shape/line kind the "Shapes and lines" tool draws next (driven by the shape menu). */
  private currentShape: ShapeKind = "rectangle";
  /** True while setTool is baking an open editor → suppresses the commit's auto-revert-to-select. */
  private suppressAutoSelect = false;
  private widthPx = 8;
  private style: StrokeStyle = "solid";
  private opacity = 1; // fixed default — the pen panel has no opacity control yet
  private drawing: { id: string; points: number[] } | null = null;
  private marquee: Konva.Rect | null = null;
  private marqueeStart: { x: number; y: number } | null = null;
  private marqueeBase = new Set<string>();
  private marqueeAdditive = false;
  private moveState: { startX: number; startY: number; dx: number; dy: number } | null = null;
  /** Active while dragging a multi-node selection as one unit (strokes + text + connectors together).
   *  Coordinates the three per-type move subsystems; `start` is the grab point for the shared delta. */
  private groupMoving = false;
  private groupMoveStart: { x: number; y: number } | null = null;
  /** A tap on an already-sole-selected text/sticky box → edit it on release (FigJam two-click:
   *  first click selects the box, second click enters its text). Cleared if the tap becomes a drag. */
  private textTapEdit: { id: string; x: number; y: number } | null = null;
  /** When/what text box was last freshly selected — the two-click edit only fires on a QUICK second
   *  click (within TWO_CLICK_MS), so a later click on a still-selected box re-selects, not edits. */
  private textSelectAt: { id: string; t: number } | null = null;
  private pinch: { dist: number; cx: number; cy: number } | null = null;
  private lastCursorSent = 0;
  /** Throttle clocks for the live drag / resize broadcasts (ms). */
  private lastDragSent = 0;
  private lastResizeSent = 0;
  /** True while the local user is actively resizing via the transformer handles. */
  private resizing = false;
  /** Throttle clock for the live in-progress-stroke broadcast (ms). */
  private lastDrawSent = 0;
  /** Ephemeral preview lines for *remote* peers' in-progress strokes, keyed by stroke id. */
  /** Ids of peers' in-progress strokes, shown as transient DOM draft <svg>s (ADR-0009 P3). */
  private readonly remoteDraws = new Set<string>();
  /** Last selection broadcast on awareness (sorted, joined) — skips republishing an unchanged set. */
  private lastPublishedSelection = "";
  /** Throttle clock for selection broadcasts during a live marquee drag (ms). */
  private lastSelectionSent = 0;
  /** Signature of the last-rendered remote selections — lets cursor-only awareness ticks skip the rebuild. */
  private lastRemoteSelKey = "";
  /** Union of remote peers' selected ids from the previous awareness tick — lets us spot an id a
   *  peer has *just* selected (last-writer-wins ownership; see yieldSelectionToPeers). */
  private prevRemoteSel = new Set<string>();
  /** Awareness listener kept as a field so destroy() can detach it (it fires after the stage is gone otherwise). */
  private readonly onAwarenessChange = (): void => {
    this.syncCursors();
    this.yieldSelectionToPeers(); // release any node a peer has just taken over (selected/dragged)…
    this.renderRemoteDraws(); // peers' in-progress strokes
    this.renderRemoteConnectors(); // peers' in-progress connector draws / moves / endpoint drags
    // force the outline rebuild when geometry moved OR a peer is live-editing a connector
    this.renderRemoteSelections(this.remoteConn.size > 0);
  };
  /** Window listeners kept as fields so destroy() can detach them (else they leak / fire on a dead stage). */
  private readonly onWindowBlur = (): void => {
    this.opts.awareness.setLocalStateField("cursor", null);
  };
  private readonly onWindowPointerUp = (): void => {
    if (this.groupMoving) this.endGroupMove();
    else if (this.textLayer.isMoving()) this.textLayer.endMove();
    else if (this.moveState) this.endMove();
    else if (this.connectorMove) this.endConnectorMove();
    else if (this.marquee) this.endMarquee();
    // Two-click: releasing a tap on an already-sole-selected box enters its text editor.
    if (this.textTapEdit) {
      const at = this.textTapEdit;
      this.textTapEdit = null;
      this.textLayer.editOrCreate(at, true); // edit with all text selected
    }
  };
  private resizeObserver: ResizeObserver | null = null;
  /** Cache of content-relative client rects per object id; cleared whenever geometry rebuilds. */
  private readonly rectCache = new Map<string, Rect>();
  private raf = 0;
  private animating = false;
  private selectionListener: ((count: number) => void) | null = null;

  constructor(private readonly opts: CanvasOptions) {
    this.objects = objectsMap(opts.doc);
    // captureTimeout 0: each edit (one transaction) is its own undo step, so undo
    // pops one stroke/move/delete at a time instead of merging rapid edits.
    this.undoManager = new Y.UndoManager([this.objects, orderArray(opts.doc)], {
      captureTimeout: 0,
    });
    this.stage = new Konva.Stage({
      container: opts.container as HTMLDivElement,
      width: opts.container.clientWidth,
      height: opts.container.clientHeight,
    });
    this.stage.add(this.content);
    this.stage.add(this.connectorLayer); // above strokes, below the overlay (cursors/selections)
    this.stage.add(this.overlay);
    this.stage.add(this.uiLayer);
    // Peers' selection outlines sit in the overlay, in world space (so they pan/zoom
    // with the board) and below the cursors (which are added to the overlay lazily).
    // Peers' in-progress strokes now render as transient DOM drafts (ADR-0009 P3).
    this.overlay.add(this.remoteSelections);

    // ADR-0009 P3 Step 4: the Konva.Transformer + group proxy are retired — every object (single or
    // multi-node group) resizes/rotates via the text-layer's DOM chrome.
    this.uiLayer.add(this.highlightGroup);

    // Camera owns the stage transform; re-sync our viewport-dependent chrome on any change.
    this.viewport = new ViewportController(this.stage, opts.container, () => {
      this.scaleCursors();
      this.syncCursorStage(); // keep the cursor stage locked to the camera
      this.renderSelectionBoxes();
      this.renderRemoteSelections(true); // zoom changes screen-space geometry → force rebuild
      this.textLayer.syncTransform(); // keep HTML text boxes locked to the camera
      this.rerouteConnectors(); // re-draw connectors so their hit area + halo stay screen-constant
      this.updateConnectorChrome(); // keep the endpoint handles locked to the camera
    });
    // The text overlay positions HTML boxes in screen space from the live camera transform.
    this.textLayer = new TextLayer({
      container: opts.container,
      doc: opts.doc,
      awareness: opts.awareness,
      camera: () => ({ scale: this.stage.scaleX(), x: this.stage.x(), y: this.stage.y() }),
      onSelectionChange: () => {
        // Re-evaluate the transform box vs the union group box for the new combined selection,
        // redraw the group box, fold the text selection into the count, and broadcast it so peers
        // see the text outline. reattachTransformer does all four (incl. notify + publish).
        this.reattachTransformer();
        this.updateConnectorChrome(); // a connector is selected in the text layer now (ADR-0009 P3)
      },
      onCommitted: (keepTool) => {
        // Finishing a box placed with the text/sticky/shapes tool reverts to select (one-shot).
        // Suppressed when the commit was triggered by an explicit tool switch, or by focus moving into
        // a tool picker (keepTool) — e.g. picking a new shape/connector from the still-open shape menu;
        // reverting there would hide the menu before the pick lands. Either way: don't fight the user.
        if (this.suppressAutoSelect || keepTool) return;
        if (this.tool === "text" || this.tool === "sticky" || this.tool === "shapes")
          this.opts.requestTool?.("select");
      },
      onShapesMoved: () => {
        this.rerouteConnectors(); // a shape moved/resized → re-route its arrows live
        this.renderSelectionBoxes(); // …and keep the union group box tracking the shape's new bounds
      },
    });

    // The dark edit bar for a selected connector — each control writes to the sole-selected connector.
    this.connectorBar = new ConnectorBar({
      setColor: (color) => this.styleSelectedConnector({ color }),
      setWidth: (width) => this.styleSelectedConnector({ width }),
      setStyle: (style) => this.styleSelectedConnector({ style }),
      setStartCap: (startCap) => this.styleSelectedConnector({ startCap }),
      setEndCap: (endCap) => this.styleSelectedConnector({ endCap }),
    });

    // The cursor stage's container is appended AFTER the text overlay → cursors paint on top of text.
    const cursorContainer = document.createElement("div");
    cursorContainer.className = "cursor-layer";
    opts.container.appendChild(cursorContainer);
    this.cursorStage = new Konva.Stage({
      container: cursorContainer,
      width: this.stage.width(),
      height: this.stage.height(),
      listening: false,
    });
    this.cursorStage.add(this.cursorLayer);
    this.syncCursorStage();

    this.onDocChanged();
    // Strokes paint as DOM <svg> via the text-layer now (ADR-0009 Phase 3 — the Konva stroke pipeline
    // is gone); the canvas only re-renders connectors + re-syncs selection/remote chrome per change.
    this.objects.observeDeep(() => this.onDocChanged());

    this.bindPointer();
    // Hand-pan moves the viewport without a zoom transform, so re-cull + re-sync text on drag too.
    this.stage.on("dragmove", () => {
      this.textLayer.syncTransform();
    });
    this.bindSelection();
    this.bindTouch();
    this.bindDragCursor();
    this.bindResize();
    this.bindAwareness();
    this.bindText();
    this.bindSticky();
    this.bindShapes();
    this.bindStamp();
    this.bindConnectors();
    this.bindEraser();

    opts.awareness.setLocalStateField("user", opts.user.name);
    opts.awareness.setLocalStateField("color", opts.user.color);
    this.setTool("select");
    this.resetZoom(); // start at the default zoom (see resetZoom)
  }

  setTool(tool: ToolId): void {
    if (this.tool === "select" && tool !== "select") {
      this.clearSelection();
      this.cancelMarquee();
    }
    // Leaving a text-editing tool (text/sticky/shapes) bakes any open editor into the doc. The bake
    // must NOT trigger the commit's auto-revert-to-select (the user is explicitly choosing a tool).
    const editingTool = (t: ToolId): boolean => t === "text" || t === "sticky" || t === "shapes";
    if (editingTool(this.tool) && tool !== this.tool) {
      this.suppressAutoSelect = true;
      this.textLayer.commit();
      this.suppressAutoSelect = false;
    }
    if (tool !== "sticky" && tool !== "shapes") this.textLayer.hideStickyGhost(); // ghost rides the place tools
    if (tool !== "stamp") this.hideStampGhost();
    if (tool !== "shapes") {
      // Leaving the shapes tool drops connector-draw mode (so other shapes stop showing their dots).
      this.currentConnector = null;
      this.textLayer.setConnectorMode(false);
    }
    this.tool = tool;
    this.stage.draggable(tool === "hand");
    this.stage.container().style.cursor =
      tool === "hand"
        ? "grab"
        : tool === "pen"
          ? PEN_CURSOR_URL
          : tool === "eraser"
            ? ERASER_CURSOR_URL
            : tool === "text"
              ? "text"
              : tool === "stamp"
                ? STAMP_CURSOR_URL
                : CURSOR_URL;
  }
  /** The colour the next dropped sticky note gets (driven by the sticky palette). */
  setStickyColor(color: string): void {
    this.stickyColor = color;
    this.textLayer.setStickyColor(color); // recolours the note currently being edited, too
  }
  /** The shape/line the "Shapes and lines" tool draws next (driven by the shape menu). */
  setShape(kind: ShapeKind): void {
    this.currentShape = kind;
    this.currentConnector = null; // a shape kind → the tool places boxes, not connectors
    this.textLayer.setConnectorMode(false);
  }
  /** Switch the shapes tool into connector-draw mode (drag to draw a line/arrow). */
  setConnector(kind: ConnectorKind): void {
    this.currentConnector = kind;
    this.textLayer.setConnectorMode(true); // show every shape's connector dots while drawing
  }
  /** The stamp/sticker the next canvas tap places (`mark:<name>` | `emoji:<codepoint>`). */
  setStamp(src: string): void {
    this.currentStamp = src;
    this.stampGhostSrc = null; // force the cursor preview to reload the new sticker
    this.stampGhostRot = Math.round((Math.random() * 30 - 15) * 10) / 10;
  }
  /** Resolve a stamp src to its SVG url — emoji → /emoji/<cp>.svg, mark → /stamps/<name>.svg. */
  private stampUrl(src: string): string {
    const i = src.indexOf(":");
    const kind = src.slice(0, i);
    const val = src.slice(i + 1);
    if (kind === "img") return val; // a data URL (e.g. the placed avatar)
    if (kind === "emoji") return `/emoji/${val}.svg`;
    return `/stamps/${val}.svg`;
  }
  private loadStampImage(src: string, node: Konva.Image): void {
    const url = this.stampUrl(src);
    const set = (img: HTMLImageElement | HTMLCanvasElement): void => {
      node.image(img);
      node.getLayer()?.batchDraw();
    };
    const cached = this.stampImgCache.get(url);
    if (cached) {
      if (cached instanceof HTMLCanvasElement || (cached.complete && cached.naturalWidth > 0))
        set(cached);
      else cached.addEventListener("load", () => set(cached), { once: true });
      return;
    }
    const isEmoji = src.startsWith("emoji:");
    const img = new window.Image();
    if (!isEmoji) this.stampImgCache.set(url, img); // marks/avatar: border already baked / circular
    img.addEventListener(
      "load",
      () => {
        const out = isEmoji ? this.emojiSticker(img) : img;
        this.stampImgCache.set(url, out);
        set(out);
      },
      { once: true },
    );
    img.src = url;
  }

  /** Render an emoji as a white-outlined sticker (canvas) so a placed emoji reads like the colour
   *  marks on the board. The Konva drop shadow behind it makes the white edge pop on a light board. */
  private emojiSticker(img: HTMLImageElement): HTMLCanvasElement {
    const S = 120;
    const pad = 7;
    const cv = document.createElement("canvas");
    cv.width = cv.height = S + pad * 2;
    const ctx = cv.getContext("2d");
    if (!ctx) return cv;
    // a white silhouette of the emoji, stamped around a ring of offsets → a uniform white outline
    const sil = document.createElement("canvas");
    sil.width = sil.height = S;
    const sctx = sil.getContext("2d");
    if (sctx) {
      sctx.drawImage(img, 0, 0, S, S);
      sctx.globalCompositeOperation = "source-in";
      sctx.fillStyle = "#ffffff";
      sctx.fillRect(0, 0, S, S);
    }
    const t = 3.5;
    for (let a = 0; a < Math.PI * 2 - 0.01; a += Math.PI / 8) {
      ctx.drawImage(sil, pad + Math.cos(a) * t, pad + Math.sin(a) * t, S, S);
    }
    ctx.drawImage(img, pad, pad, S, S);
    return cv;
  }
  setColor(color: string): void {
    this.color = color;
  }
  setWidth(width: number): void {
    this.widthPx = width;
  }
  setStyle(style: StrokeStyle): void {
    this.style = style;
  }

  // ---- zoom controls (delegated to the camera; driven by the bottom-left widget) ----
  setZoomListener(cb: (pct: number) => void): void {
    this.viewport.setZoomListener(cb);
  }
  getZoomPercent(): number {
    return this.viewport.getZoomPercent();
  }
  zoomBy(factor: number): void {
    this.viewport.zoomBy(factor);
  }
  zoomStep(dir: number): void {
    this.viewport.zoomStep(dir);
  }
  resetZoom(): void {
    this.viewport.resetZoom();
  }
  /** Set an absolute zoom (1 = 100%), clamped to the supported range. */
  zoomTo(scale: number): void {
    this.viewport.zoomTo(scale);
  }
  /** Frame all content in view (or reset when the board is empty). */
  zoomToFit(): void {
    // Strokes/connectors/text all live in the text-layer now (ADR-0009 P3) — frame the union of
    // every object's world rect instead of the (now-empty) Konva content layer.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of orderArray(this.opts.doc).toArray()) {
      const r = this.textLayer.worldRectOf(id);
      if (!r) continue;
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.width);
      maxY = Math.max(maxY, r.y + r.height);
    }
    if (minX > maxX) return;
    this.viewport.zoomToFitBox({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  }

  private point(): { x: number; y: number } {
    const p = this.stage.getRelativePointerPosition();
    return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
  }

  /** Content-relative client rect of an object's node, cached until renderObjects clears it. */
  private nodeRect(id: string, node: Konva.Node): Rect {
    let r = this.rectCache.get(id);
    if (!r) {
      // skipShadow: the selection box should hug the node, not its drop shadow — a stamp's soft shadow
      // otherwise inflates the box (and the inflation grows/shifts as the stamp rotates).
      r = node.getClientRect({ relativeTo: node.getLayer() ?? this.content, skipShadow: true });
      this.rectCache.set(id, r);
    }
    return r;
  }

  /** World-space bbox of a stroke straight from its points (+ stroke half-width). */
  private strokeBBox(obj: StrokeObject): Rect {
    const p = obj.points;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < p.length; i += 2) {
      const x = p[i] as number;
      const y = p[i + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minX > maxX) return { x: 0, y: 0, width: 0, height: 0 };
    const pad = (obj.style.includes("highlight") ? obj.width * 1.6 : obj.width) / 2 + 1;
    return {
      x: minX - pad,
      y: minY - pad,
      width: maxX - minX + pad * 2,
      height: maxY - minY + pad * 2,
    };
  }

  private onDocChanged(): void {
    // Strokes paint via the text-layer (ADR-0009 P3). On each doc change: re-render connectors
    // (Konva), then re-sync the transform box, peers' selection outlines, and prune a just-committed peer draw.
    this.renderConnectors();
    this.reattachTransformer();
    this.renderRemoteSelections(true);
    this.pruneCommittedDraws();
  }

  /** Remove any remote-draw preview now backed by a committed node (clean draw→commit handoff). */
  private pruneCommittedDraws(): void {
    if (!this.remoteDraws.size) return;
    for (const id of this.remoteDraws) {
      if (!this.objects.has(id)) continue; // committed → the text-layer renders the real svg
      this.textLayer.removeInkDraft(`remote:${id}`);
      this.remoteDraws.delete(id);
    }
  }

  // ---- pen / drawing ----
  /** The live StrokeObject for an in-progress draft preview, using the current pen style. */
  private draftStroke(d: { id: string; points: number[] }): StrokeObject {
    return {
      id: d.id,
      type: "stroke",
      points: d.points,
      color: this.color,
      width: this.widthPx,
      style: this.style,
      opacity: this.opacity,
      authorId: String(this.opts.awareness.clientID),
    };
  }
  private bindPointer(): void {
    this.stage.on("pointerdown", () => {
      if (this.tool !== "pen") return;
      const p = this.point();
      this.drawing = { id: randomId("st"), points: [p.x, p.y] };
      // In-progress preview is a transient DOM <svg> on top of everything (ADR-0009 Phase 3 Step 6).
      this.textLayer.upsertInkDraft("local", this.draftStroke(this.drawing));
    });

    this.stage.on("pointermove", () => {
      const p = this.point();
      this.publishCursor(p);
      if (this.tool === "sticky") this.textLayer.showStickyGhost(p, this.stickyColor); // placement preview
      if (this.tool === "shapes" && !this.currentConnector)
        this.textLayer.showShapeGhost(p, this.currentShape, DEFAULT_SHAPE_FILL);
      if (this.tool === "text") {
        // I-beam over an existing text box (click to edit it); the default cursor over empty board.
        this.stage.container().style.cursor = this.textLayer.hitTest(p) ? "text" : CURSOR_URL;
      }
      if (this.tool === "stamp") this.updateStampGhost(p);
      if (!this.drawing) return;
      this.drawing.points.push(p.x, p.y);
      this.textLayer.upsertInkDraft("local", this.draftStroke(this.drawing));
      // Stream the in-progress stroke to peers (throttled like cursors). It's ephemeral —
      // addStroke commits the finished stroke on finish(), so no doc/undo churn mid-draw.
      const now = Date.now();
      if (now - this.lastDrawSent >= 1000 / CURSOR_HZ) {
        this.lastDrawSent = now;
        this.opts.awareness.setLocalStateField("draw", {
          id: this.drawing.id,
          points: downsamplePoints(this.drawing.points, MAX_PREVIEW_VERTS),
          color: this.color,
          width: this.widthPx,
          style: this.style,
          opacity: this.opacity,
        });
      }
    });

    const finish = (): void => {
      const d = this.drawing;
      this.drawing = null;
      if (!d) return;
      this.textLayer.removeInkDraft("local"); // drop the preview; the doc observer paints the committed svg
      if (d.points.length >= 4) {
        const stroke: StrokeObject = {
          id: d.id,
          type: "stroke",
          points: d.points,
          color: this.color,
          width: this.widthPx,
          style: this.style,
          opacity: this.opacity,
          authorId: String(this.opts.awareness.clientID),
        };
        // The committed stroke is hittable the instant the text-layer's observer populates `sizes`
        // (geometry hit-test) — no Konva hit-graph priming needed (ADR-0009 Phase 3 Step 6).
        addStroke(this.opts.doc, stroke);
        this.opts.onPlaced?.(); // a real stroke landed → collapse the mobile draw sheet
      }
      this.opts.awareness.setLocalStateField("draw", null); // …then end the live preview
    };
    this.stage.on("pointerup", finish);
    this.stage.on("pointerleave", () => {
      finish(); // a connector/stroke dragged off the canvas edge still commits
      this.textLayer.hideStickyGhost(); // pointer left the canvas → drop the placement preview
      this.hideStampGhost();
    });
    // Hide my cursor for peers only on a *real* board exit — when the pointer leaves the whole canvas
    // container — NOT when it merely moves from the canvas onto one of the board's own HTML overlays
    // (connector endpoint handles, text boxes), which are children of this same container. Those
    // overlays keep publishing the cursor while hovered, so it follows them instead of vanishing
    // (hovering an arrow's endpoint node used to fire the stage's pointerleave and clear the cursor for
    // everyone). pointerleave doesn't bubble and ignores moves between descendants, so this fires only
    // on a true exit — including leaving via an overlay, which the stage's own leave never saw.
    this.opts.container.addEventListener("pointerleave", () => {
      this.opts.awareness.setLocalStateField("cursor", null);
      this.hidePeerTip();
    });
    window.addEventListener("blur", this.onWindowBlur);
  }

  // ---- eraser: a click deletes the object under the pointer; a drag deletes everything its path
  //      crosses. Each pointer event commits its hits to the doc immediately (one transaction → peers
  //      see the erasure in realtime); the raised captureTimeout merges the whole swipe into ONE undo
  //      step. A faint ghost trail follows the cursor and fades/shrinks away on its own (eraserTail). ----
  private bindEraser(): void {
    this.stage.on("pointerdown", () => {
      if (this.tool !== "eraser") return;
      const p = this.point();
      this.erasing = true;
      this.lastErasePoint = p;
      this.undoManager.captureTimeout = ERASER_UNDO_MERGE_MS; // merge the swipe's deletes into one step…
      this.undoManager.stopCapturing(); // …but start fresh — don't merge into the preceding edit (a draw)
      this.pushEraserTrail(p);
      const batch = new Set<string>();
      this.eraseHits(p, batch); // a plain click already erases the node under it
      if (batch.size) deleteObjects(this.opts.doc, [...batch]);
      this.ensureEraserTail();
    });
    this.stage.on("pointermove", () => {
      if (!this.erasing || !this.lastErasePoint) return;
      const p = this.point();
      const batch = new Set<string>();
      this.eraseAlongSegment(this.lastErasePoint.x, this.lastErasePoint.y, p.x, p.y, batch);
      this.lastErasePoint = p;
      this.pushEraserTrail(p);
      if (batch.size) deleteObjects(this.opts.doc, [...batch]); // commit live → realtime for peers
    });
    const finishErase = (): void => {
      if (!this.erasing) return;
      this.erasing = false;
      this.lastErasePoint = null;
      this.undoManager.captureTimeout = 0; // back to one-step-per-edit for everything else…
      this.undoManager.stopCapturing(); // …and don't let the next edit merge into the erase step
    };
    this.stage.on("pointerup", finishErase);
    this.stage.on("pointerleave", finishErase);
  }

  /** Collect the topmost object under one world point into `batch` (a Set, so a point hit twice counts
   *  once). `textLayer.hitTest` now resolves EVERY type — strokes, connectors, text, shapes, stickies,
   *  stamps — by walking orderArray back-to-front (ADR-0009 Phase 3), so the eraser no longer needs the
   *  Konva hit graph. The caller deletes the whole batch in a single transaction. */
  private eraseHits(world: { x: number; y: number }, batch: Set<string>): void {
    const tid = this.textLayer.hitTest(world);
    if (tid) batch.add(tid);
  }

  /** Sample the segment between two world points (≈ every 4 px on screen) so a fast drag erases
   *  everything it sweeps over instead of skipping objects between pointermove events. */
  private eraseAlongSegment(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    batch: Set<string>,
  ): void {
    const scale = this.stage.scaleX() || 1;
    const steps = Math.max(1, Math.ceil((Math.hypot(x2 - x1, y2 - y1) * scale) / 4));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.eraseHits({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t }, batch);
    }
  }

  /** Append a world point to the fading ghost trail (lazily creating the overlay line). */
  private pushEraserTrail(p: { x: number; y: number }): void {
    if (!this.eraserTail) {
      const ghost = new Konva.Line({
        stroke: "#9aa3af",
        strokeWidth: ERASER_GHOST_W / (this.stage.scaleX() || 1), // ~constant px at any zoom
        opacity: 0.32,
        lineCap: "round",
        lineJoin: "round",
        listening: false,
      });
      this.overlay.add(ghost);
      this.eraserTail = { ghost, trail: [] };
    }
    this.eraserTail.trail.push({ x: p.x, y: p.y, t: Date.now() });
  }

  private ensureEraserTail(): void {
    if (!this.eraserRaf) this.eraserRaf = requestAnimationFrame(this.eraserTailStep);
  }
  /** Age the ghost trail each frame: drop points older than ERASER_TAIL_MS and fade the line as its
   *  newest point ages — so the trail shrinks + fades out shortly after the cursor stops (or the
   *  gesture ends), instead of lingering as a solid line. */
  private readonly eraserTailStep = (): void => {
    this.eraserRaf = 0;
    const tail = this.eraserTail;
    if (tail) {
      const now = Date.now();
      while (tail.trail.length && now - tail.trail[0]!.t > ERASER_TAIL_MS) tail.trail.shift();
      if (!tail.trail.length && !this.erasing) {
        tail.ghost.destroy();
        this.eraserTail = null;
      } else {
        const pts: number[] = [];
        for (const q of tail.trail) pts.push(q.x, q.y);
        tail.ghost.points(pts);
        const newestAge = tail.trail.length
          ? now - tail.trail[tail.trail.length - 1]!.t
          : ERASER_TAIL_MS;
        tail.ghost.opacity(0.32 * Math.max(0, 1 - newestAge / ERASER_TAIL_MS));
      }
      this.overlay.batchDraw();
    }
    if (this.eraserTail || this.erasing) this.ensureEraserTail();
  };

  // ---- text + sticky (tap to place) ----
  /** Shared tap-to-place binding for the text + sticky tools. Movement is tracked across
   *  pointermove (reliable while the pointer is down) rather than from the pointerup position —
   *  on touch, getRelativePointerPosition() can be stale/null at touchend, which would otherwise
   *  turn every tap into a "drag" and silently drop the placement (the mobile bug). */
  private bindTapPlace(
    tool: ToolId,
    place: (at: { x: number; y: number }, client?: { x: number; y: number }) => void,
  ): void {
    let down: { x: number; y: number } | null = null;
    let client: { x: number; y: number } | null = null;
    let moved = false;
    this.stage.on("pointerdown", (e) => {
      if (this.tool !== tool) return;
      down = this.point();
      const ev = e.evt as PointerEvent; // viewport coords for caret-from-point on an edit
      client = { x: ev.clientX, y: ev.clientY };
      moved = false;
    });
    this.stage.on("pointermove", () => {
      if (this.tool !== tool || !down) return;
      const p = this.point();
      if (Math.hypot(p.x - down.x, p.y - down.y) > this.textLayer.tapSlop()) moved = true;
    });
    this.stage.on("pointerup", () => {
      if (this.tool !== tool || !down) return;
      const at = down;
      const c = client;
      const wasTap = !moved;
      down = null;
      client = null;
      if (wasTap) place(at, c ?? undefined); // drag-to-size a fixed-width box is a later increment
    });
  }

  private bindText(): void {
    this.bindTapPlace("text", (at, client) => this.textLayer.editOrCreate(at, false, client));
  }

  private bindSticky(): void {
    this.bindTapPlace("sticky", (at) => {
      this.textLayer.stickyAt(at, this.stickyColor);
      this.opts.onPlaced?.(); // collapse the mobile sticky sheet while you type the label
    });
  }

  private bindStamp(): void {
    this.bindTapPlace("stamp", (at) => {
      if (!this.currentStamp) return; // no stamp picked yet → the wheel is just open
      addStamp(this.opts.doc, {
        id: randomId("sp"),
        type: "stamp",
        x: at.x,
        y: at.y,
        size: DEFAULT_STAMP_SIZE,
        src: this.currentStamp,
        rotation: this.stampGhostRot, // land at exactly the previewed tilt
        authorId: String(this.opts.awareness.clientID),
      });
      this.stampBurst(at.x, at.y, DEFAULT_STAMP_SIZE); // celebratory pop where it lands
      this.stampGhostRot = Math.round((Math.random() * 30 - 15) * 10) / 10; // fresh tilt for the next
      this.opts.onStampPlaced?.(this.currentStamp); // host bumps the emoji recents
      this.opts.onPlaced?.(); // (mobile) collapse the sheet — the tool stays active to stamp more
    });
  }

  /** A quick celebratory pop when a stamp lands: 6 evenly-spaced spokes shoot outward from the
   *  centre and fade. Drawn on the overlay (world space), self-destructs when the tween completes. */
  private stampBurst(cx: number, cy: number, size: number): void {
    const N = 6;
    const inner = size * 0.5;
    const spread = size * 0.6;
    const len = size * 0.17;
    // Theme-aware ink: dark spokes on a light board, light spokes on a dark board (not the accent).
    const color =
      getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || "#0e1116";
    const group = new Konva.Group({ x: cx, y: cy, listening: false });
    const spokes: { line: Konva.Line; ux: number; uy: number }[] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 - Math.PI / 2; // start straight up, evenly around
      const line = new Konva.Line({
        stroke: color,
        strokeWidth: Math.max(2, size * 0.05),
        lineCap: "round",
      });
      group.add(line);
      spokes.push({ line, ux: Math.cos(a), uy: Math.sin(a) });
    }
    this.overlay.add(group);
    const start = performance.now();
    const DUR = 460;
    const ease = (t: number): number => 1 - Math.pow(1 - t, 3); // easeOutCubic
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / DUR);
      const r = inner + spread * ease(t);
      group.opacity(1 - t);
      for (const sp of spokes)
        sp.line.points([sp.ux * r, sp.uy * r, sp.ux * (r + len), sp.uy * (r + len)]);
      this.overlay.batchDraw();
      if (t < 1) requestAnimationFrame(tick);
      else {
        group.destroy();
        this.overlay.batchDraw();
      }
    };
    requestAnimationFrame(tick);
  }

  /** Translucent preview of the armed stamp, centred on the cursor while the stamp tool is active. */
  private updateStampGhost(p: { x: number; y: number }): void {
    if (!this.currentStamp) return this.hideStampGhost();
    if (!this.stampGhost) {
      this.stampGhost = new Konva.Image({ image: undefined, listening: false, opacity: 0.5 });
      this.overlay.add(this.stampGhost);
    }
    const g = this.stampGhost;
    const size = DEFAULT_STAMP_SIZE;
    if (this.stampGhostSrc !== this.currentStamp) {
      this.stampGhostSrc = this.currentStamp;
      const cached = this.stampImgCache.get(this.stampUrl(this.currentStamp));
      const ready =
        cached instanceof HTMLCanvasElement ||
        (!!cached && cached.complete && cached.naturalWidth > 0);
      if (!ready) g.image(undefined); // don't show the previous stamp while the new one loads
      this.loadStampImage(this.currentStamp, g);
    }
    g.size({ width: size, height: size });
    g.offset({ x: size / 2, y: size / 2 }); // centred on the drop point
    g.position({ x: p.x, y: p.y });
    g.rotation(this.stampGhostRot);
    g.visible(true);
    this.overlay.batchDraw();
  }
  private hideStampGhost(): void {
    if (this.stampGhost?.visible()) {
      this.stampGhost.visible(false);
      this.overlay.batchDraw();
    }
  }

  private bindShapes(): void {
    this.bindTapPlace("shapes", (at) => {
      if (this.currentConnector) return; // connector mode draws on drag (bindConnectors), not tap-place
      this.textLayer.shapeAt(at, this.currentShape, DEFAULT_SHAPE_FILL);
      this.opts.onPlaced?.(); // collapse the mobile shape sheet while you type the label
    });
  }

  // ---- connectors (lines / arrows, optionally bound to a shape side) ----

  /** Resolve a connector end to a world point: a bound end follows its shape's live side mid-edge; a
   *  free end (or a binding whose shape is gone) uses its stored point. */
  private resolveConnectorEnd(end: ConnectorEnd): { x: number; y: number } {
    if (end.shapeId && end.side) {
      const rect = this.textLayer.shapeWorldRect(end.shapeId);
      if (rect) return sideMidpoint(rect, end.side);
    }
    return { x: end.x, y: end.y };
  }

  /** The world-space polyline for a connector: a single-bend L-route for elbows (exiting perpendicular
   *  to the bound start side), else a straight segment. */
  private connectorPolyline(kind: ConnectorKind, from: ConnectorEnd, to: ConnectorEnd): number[] {
    const a = this.resolveConnectorEnd(from);
    const b = this.resolveConnectorEnd(to);
    // A near-aligned elbow collapses to a straight line (a degenerate corner would otherwise sit on
    // an endpoint and break the arrowhead angle).
    if (kind === "elbow" && Math.abs(b.x - a.x) > 1 && Math.abs(b.y - a.y) > 1) {
      const horizontalFirst =
        from.side === "left" || from.side === "right"
          ? true
          : from.side === "top" || from.side === "bottom"
            ? false
            : Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
      const corner = horizontalFirst ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
      return [a.x, a.y, corner.x, corner.y, b.x, b.y];
    }
    return [a.x, a.y, b.x, b.y];
  }

  /** The Konva shapes for one endpoint cap, oriented along `angle` (the outward direction). */
  private capShapes(
    p: { x: number; y: number },
    angle: number,
    cap: ConnectorCap,
    color: string,
    w: number,
  ): Konva.Shape[] {
    if (cap === "none") return [];
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const px = -sin;
    const py = cos; // unit perpendicular
    if (cap === "arrow" || cap === "triangle" || cap === "line") {
      const len = w * 3.2;
      const half = w * 2;
      const bx = p.x - cos * len;
      const by = p.y - sin * len;
      const b1x = bx + px * half;
      const b1y = by + py * half;
      const b2x = bx - px * half;
      const b2y = by - py * half;
      if (cap === "line") {
        // open "V" head (matches the arrow/elbow menu icons)
        return [
          new Konva.Line({
            points: [b1x, b1y, p.x, p.y, b2x, b2y],
            stroke: color,
            strokeWidth: w,
            lineCap: "round",
            lineJoin: "round",
            listening: false,
          }),
        ];
      }
      // closed triangle — filled in the line colour (arrow) or outlined + white (triangle).
      const outline = cap === "triangle";
      return [
        new Konva.Line({
          points: [p.x, p.y, b1x, b1y, b2x, b2y],
          closed: true,
          fill: outline ? "#ffffff" : color,
          stroke: color,
          strokeWidth: outline ? w * 0.8 : w * 0.5,
          lineJoin: "round",
          listening: false,
        }),
      ];
    }
    if (cap === "circle") {
      return [
        new Konva.Circle({
          x: p.x,
          y: p.y,
          radius: w * 1.6,
          stroke: color,
          strokeWidth: w * 0.8,
          fill: "#ffffff",
          listening: false,
        }),
      ];
    }
    // diamond
    const rd = w * 1.9;
    return [
      new Konva.Line({
        points: [p.x, p.y - rd, p.x + rd, p.y, p.x, p.y + rd, p.x - rd, p.y],
        closed: true,
        stroke: color,
        strokeWidth: w * 0.8,
        fill: "#ffffff",
        listening: false,
      }),
    ];
  }

  /** How far a solid cap's body extends back from the tip — the shaft is trimmed by this so it stops
   *  at the cap's base instead of poking through (open "line"/none reach the tip). */
  private capInset(cap: ConnectorCap, w: number): number {
    if (cap === "arrow" || cap === "triangle") return w * 3.2; // triangle length
    if (cap === "circle") return w * 1.6; // radius
    if (cap === "diamond") return w * 1.9; // half-diagonal
    return 0;
  }

  /** The selection-halo colour for a connector: blue when I've selected it, the selecting peer's
   *  colour when THEY have, else null (not selected). The connector keeps its OWN colour; selection
   *  is shown as an outline/halo, not by recolouring it. */
  private connectorSelColor(id: string): string | null {
    if (this.selectedConnectors.has(id)) return SELECT_BLUE;
    return this.remoteConnSel.get(id) ?? null;
  }

  /** (Re)build a connector group: an optional selection halo, then the shaft + its two cap shapes.
   *  The hit area is a constant ~20 px on screen so the line is easy to grab at any zoom. */
  private drawConnector(group: Konva.Group, conn: ConnectorObject, selColor: string | null): void {
    group.destroyChildren();
    const w = conn.width;
    const scale = this.stage.scaleX() || 1;
    const pts = this.connectorPolyline(conn.kind, conn.from, conn.to);
    const n = pts.length;
    // A bound end attaches at the shape's side mid-edge — on its border. The connector layer paints
    // UNDER the HTML shape overlay, so an endpoint sitting on the border gets clipped: an arrowhead
    // reads as "cut off" and a round line cap pokes past the edge into the shape. Pull a bound end
    // inward by half the stroke (clears the round cap) + a small margin, so the drawn cap/arrowhead
    // stops just OUTSIDE the shape. The logical endpoint (handles, re-routing) stays on the border.
    const pullBoundIn = (tipI: number, prevI: number, bound: boolean): void => {
      if (!bound) return;
      const tx = pts[tipI]!,
        ty = pts[tipI + 1]!,
        qx = pts[prevI]!,
        qy = pts[prevI + 1]!;
      const seg = Math.hypot(tx - qx, ty - qy) || 1;
      const t = Math.min((w / 2 + 2.5 / scale) / seg, 0.45); // never cross a short connector's middle
      pts[tipI] = tx - (tx - qx) * t;
      pts[tipI + 1] = ty - (ty - qy) * t;
    };
    pullBoundIn(n - 2, n - 4, !!conn.to.shapeId);
    pullBoundIn(0, 2, !!conn.from.shapeId);
    const end = { x: pts[n - 2]!, y: pts[n - 1]! };
    const endPrev = { x: pts[n - 4]!, y: pts[n - 3]! };
    const start = { x: pts[0]!, y: pts[1]! };
    const startNext = { x: pts[2]!, y: pts[3]! };
    const endAngle = Math.atan2(end.y - endPrev.y, end.x - endPrev.x);
    const startAngle = Math.atan2(start.y - startNext.y, start.x - startNext.x);
    // Selection halo (behind): a slightly wider, semi-transparent outline. The arrowhead halo uses
    // the cap's NORMAL size with just a fatter outline stroke (passing a bigger width scales the
    // whole head up → the giant-arrow look).
    if (selColor) {
      const halo = 6 / scale; // ~3 px of halo on each side, constant on screen
      group.add(
        new Konva.Line({
          points: pts,
          stroke: selColor,
          strokeWidth: w + halo,
          opacity: 0.5,
          lineCap: "round",
          lineJoin: "round",
          listening: false,
        }),
      );
      for (const cap of [
        ...this.capShapes(end, endAngle, conn.endCap, selColor, w),
        ...this.capShapes(start, startAngle, conn.startCap, selColor, w),
      ]) {
        cap.strokeWidth((cap.strokeWidth() || 0) + halo); // fatten the outline, not the whole head
        cap.opacity(0.5);
        group.add(cap);
      }
    }
    // The shaft stops at a solid cap's base (trim its endpoints inward); caps still sit at the tips.
    const shaft = pts.slice();
    const trim = (tipI: number, prevI: number, inset: number): void => {
      if (inset <= 0) return;
      const tx = pts[tipI]!;
      const ty = pts[tipI + 1]!;
      const qx = pts[prevI]!;
      const qy = pts[prevI + 1]!;
      const seg = Math.hypot(tx - qx, ty - qy) || 1;
      const t = Math.min(inset / seg, 0.95);
      shaft[tipI] = tx - (tx - qx) * t;
      shaft[tipI + 1] = ty - (ty - qy) * t;
    };
    trim(n - 2, n - 4, this.capInset(conn.endCap, w));
    trim(0, 2, this.capInset(conn.startCap, w));
    group.add(
      new Konva.Line({
        points: shaft,
        stroke: conn.color,
        strokeWidth: w,
        dash: conn.style === "dashed" ? [w * 2.5, w * 2] : [],
        lineCap: "round",
        lineJoin: "round",
        hitStrokeWidth: Math.max(w, 20 / scale), // ≥20 px on screen → easy to grab at any zoom
        listening: true,
      }),
    );
    for (const s of this.capShapes(end, endAngle, conn.endCap, conn.color, w)) group.add(s);
    for (const s of this.capShapes(start, startAngle, conn.startCap, conn.color, w)) group.add(s);
  }

  /** Reconcile connector groups with the doc (full pass — from the doc observer). */
  private renderConnectors(): void {
    const seen = new Set<string>();
    this.connectorsByShape.clear();
    this.objects.forEach((m, id) => {
      const obj = readObject(m);
      if (obj?.type !== "connector") return;
      seen.add(id);
      for (const e of [obj.from, obj.to]) {
        if (!e.shapeId) continue;
        let set = this.connectorsByShape.get(e.shapeId);
        if (!set) this.connectorsByShape.set(e.shapeId, (set = new Set()));
        set.add(id);
      }
      let group = this.connectorNodes.get(id);
      if (!group) {
        group = new Konva.Group();
        group.setAttr(OBJ_ID_ATTR, id);
        this.connectorLayer.add(group);
        this.connectorNodes.set(id, group);
      }
      this.drawConnector(group, obj, this.connectorSelColor(id));
      group.opacity(0); // ADR-0009 P3 step1: DOM <svg> paints the connector; group kept hittable-only
      group.visible(!this.remoteConnectorIds.has(id)); // hidden while a peer is live-editing it
    });
    for (const [id, group] of this.connectorNodes) {
      if (seen.has(id)) continue;
      group.destroy();
      this.connectorNodes.delete(id);
      this.selectedConnectors.delete(id);
    }
    this.connectorLayer.batchDraw();
    if (!this.connectorEndDrag) this.updateConnectorChrome();
  }

  /** Re-draw connector groups (geometry + caps) — called each frame a bound shape is dragged and on
   *  selection change. */
  private rerouteConnectors(): void {
    if (!this.connectorNodes.size) return;
    for (const [id, group] of this.connectorNodes) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type === "connector") this.drawConnector(group, obj, this.connectorSelColor(id));
    }
    this.connectorLayer.batchDraw();
    if (!this.connectorEndDrag) this.updateConnectorChrome(); // keep handles glued (not mid-handle-drag)
  }
  private refreshConnectorSelection(): void {
    this.rerouteConnectors(); // a redraw re-tints by the current selection
  }

  /** Snap a draw point to the nearest shape connector point (side mid-edge) within ~18px on screen.
   *  Returns the bound end, or a free end at `world` when nothing is close enough. */
  private snapConnectorEnd(world: { x: number; y: number }): ConnectorEnd {
    const scale = this.stage.scaleX() || 1;
    const threshold = 18 / scale;
    let best: { end: ConnectorEnd; d: number } | null = null;
    for (const id of this.textLayer.shapeIds()) {
      const rect = this.textLayer.shapeWorldRect(id);
      if (!rect) continue;
      for (const side of CONNECTOR_SIDES) {
        const p = sideMidpoint(rect, side);
        const d = Math.hypot(p.x - world.x, p.y - world.y);
        if (d <= threshold && (!best || d < best.d)) best = { end: { ...p, shapeId: id, side }, d };
      }
    }
    return best ? best.end : { x: world.x, y: world.y };
  }

  /** A live preview connector object (default caps for the current kind) from `from` → `to`. */
  private previewConnector(from: ConnectorEnd, to: ConnectorEnd): ConnectorObject {
    const caps = defaultCapsFor(this.currentConnector ?? "arrow");
    return {
      id: this.drawingConnector?.id ?? "preview",
      type: "connector",
      kind: this.currentConnector ?? "arrow",
      from,
      to,
      color: DEFAULT_CONNECTOR_COLOR,
      width: DEFAULT_CONNECTOR_WIDTH,
      style: "solid",
      startCap: caps.startCap,
      endCap: caps.endCap,
      authorId: "",
    };
  }

  /** Connector tool: press → drag → release to draw a line/arrow. Each end snaps to a shape's
   *  connector point (binding to it) or stays free; the snapped shape's dots collapse to the lock. */
  private bindConnectors(): void {
    this.stage.on("pointerdown", () => {
      if (this.tool !== "shapes" || !this.currentConnector || this.drawingConnector) return;
      const from = this.snapConnectorEnd(this.point());
      const group = new Konva.Group({ listening: false });
      this.connectorLayer.add(group);
      this.drawingConnector = { id: randomId("cn"), from, node: group };
      this.updateDrawPreview(from);
    });
    this.stage.on("pointermove", () => {
      if (!this.drawingConnector || !this.currentConnector) return;
      this.updateDrawPreview(this.snapConnectorEnd(this.point()));
    });
    const finish = (): void => {
      const d = this.drawingConnector;
      this.drawingConnector = null;
      this.textLayer.setSnapTarget(null);
      if (!d) return;
      if (this.currentConnector) {
        d.node.destroy(); // the doc observer re-adds it authoritatively
        const to = this.snapConnectorEnd(this.point());
        const a = this.resolveConnectorEnd(d.from);
        const b = this.resolveConnectorEnd(to);
        const minLen = 6 / (this.stage.scaleX() || 1);
        if (Math.hypot(b.x - a.x, b.y - a.y) >= minLen) {
          addConnector(this.opts.doc, {
            ...this.previewConnector(d.from, to),
            id: d.id,
            authorId: String(this.opts.awareness.clientID),
          });
          if (!d.from.shapeId && !to.shapeId) {
            // Both ends landed free → this is a standalone line/arrow, not wired into the diagram, so
            // treat it like a placed object: select it and drop to the select tool so its edit bar +
            // endpoint handles are immediately usable. A connector bound to ANY shape instead stays in
            // draw mode for rapid diagramming (the observeDeep above already created its group, so the
            // selection chrome can attach). publishSelection goes out after the addConnector commit.
            this.selected.clear();
            // ADR-0009 P3: select the new connector in the text layer (unified path). selectText →
            // onSelectionChange → reattachTransformer (notify + publish) + updateConnectorChrome (handles/bar).
            this.textLayer.selectText(d.id);
            this.opts.requestTool?.("select");
          } else {
            this.opts.onPlaced?.(); // bound → collapse the mobile sheet, keep the connector tool active
          }
        } else {
          this.connectorLayer.batchDraw();
        }
      }
      // Always clear the live-draw preview that updateDrawPreview() streamed to peers. Without this the
      // "connector" awareness field stays set after the draw, so peers keep showing the (listening:false)
      // glide copy and hide the real committed connector forever — it'd be uninteractive on their screen.
      // Commit (above) goes out before this clear, so peers reveal the committed copy already in place.
      this.broadcastConnectorEdit(null);
    };
    this.stage.on("pointerup", finish);
  }

  /** Redraw the in-progress connector preview to `to`, and flag the snapped shape point (if any) so
   *  the text layer collapses that shape's dots to just the locked one. */
  private updateDrawPreview(to: ConnectorEnd): void {
    const d = this.drawingConnector;
    if (!d) return;
    const draft = { ...this.previewConnector(d.from, to), id: d.id };
    this.drawConnector(d.node, draft, null);
    this.connectorLayer.batchDraw();
    this.broadcastConnectorEdit(draft); // peers see the connector being drawn live
    const bound = to.shapeId && to.side ? to : d.from.shapeId && d.from.side ? d.from : null;
    this.textLayer.setSnapTarget(
      bound?.shapeId && bound.side ? { shapeId: bound.shapeId, side: bound.side } : null,
    );
  }

  // ---- selected-connector chrome: two draggable endpoint handles ----

  /** The single selected connector id, or null when the selection isn't exactly one connector. */
  private soleSelectedConnector(): string | null {
    // Connectors are selected in the text layer now (ADR-0009 P3): sole = exactly one text-layer
    // selection that is a connector, with no Konva-stroke selection alongside.
    if (this.selected.size) return null;
    const ids = this.textLayer.selectedIds();
    if (ids.length !== 1 || ids[0] == null) return null;
    const m = this.objects.get(ids[0]);
    const obj = m ? readObject(m) : null;
    return obj?.type === "connector" ? ids[0] : null;
  }

  private clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.stage.container().getBoundingClientRect();
    const s = this.stage.scaleX() || 1;
    return {
      x: (clientX - rect.left - this.stage.x()) / s,
      y: (clientY - rect.top - this.stage.y()) / s,
    };
  }

  private ensureConnectorHandles(): HTMLDivElement {
    if (this.connectorHandlesEl) return this.connectorHandlesEl;
    const wrap = document.createElement("div");
    wrap.className = "co-connector-handles";
    for (const which of ["from", "to"] as const) {
      const h = document.createElement("div");
      h.className = "co-connector-handle";
      h.dataset.which = which;
      h.addEventListener("pointerdown", (e) => {
        const id = this.soleSelectedConnector();
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        this.connectorEndDrag = { id, which };
        try {
          h.setPointerCapture(e.pointerId); // route the drag here even when it leaves the handle
        } catch {
          /* a synthetic pointer can't be captured — the drag still works while over the handle */
        }
      });
      h.addEventListener("pointermove", (e) => {
        // Publish on every move over the handle — hover OR drag. The handle sits over the canvas, so the
        // stage sees no pointermove here; without this my cursor freezes/vanishes for peers whenever the
        // pointer is on an endpoint node.
        const world = this.clientToWorld(e.clientX, e.clientY);
        this.publishCursor(world);
        const d = this.connectorEndDrag;
        if (!d) return;
        this.previewConnectorEnd(d.id, d.which, this.snapConnectorEnd(world));
      });
      const up = (e: PointerEvent): void => {
        const d = this.connectorEndDrag;
        this.connectorEndDrag = null;
        this.textLayer.setSnapTarget(null);
        if (d) {
          // Commit the doc FIRST, then end the live preview: peers process the doc update before the
          // awareness clear, so they reveal the committed copy already at its final endpoint (otherwise
          // the connector flashes back to its pre-drag position for a frame).
          const end = this.snapConnectorEnd(this.clientToWorld(e.clientX, e.clientY));
          setConnectorEnds(this.opts.doc, d.id, d.which === "from" ? { from: end } : { to: end });
        }
        this.broadcastConnectorEdit(null); // stop the live endpoint-drag preview for peers
      };
      h.addEventListener("pointerup", up);
      h.addEventListener("pointercancel", up);
      wrap.appendChild(h);
    }
    this.opts.container.appendChild(wrap);
    this.connectorHandlesEl = wrap;
    return wrap;
  }

  /** Live-redraw a connector with one end overridden (during an endpoint drag) + move the handles. */
  private previewConnectorEnd(id: string, which: "from" | "to", end: ConnectorEnd): void {
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    if (obj?.type !== "connector") return;
    const draft: ConnectorObject = { ...obj, [which]: end };
    // The visible connector is the DOM <svg> now (the Konva node is opacity 0) — repaint it live.
    this.textLayer.previewConnector(id, which === "from" ? { from: end } : { to: end });
    const group = this.connectorNodes.get(id);
    if (group) this.drawConnector(group, draft, SELECT_BLUE);
    this.connectorLayer.batchDraw();
    this.positionConnectorHandles(draft);
    this.broadcastConnectorEdit(draft); // peers see the endpoint being dragged live
    this.textLayer.setSnapTarget(
      end.shapeId && end.side ? { shapeId: end.shapeId, side: end.side } : null,
    );
  }

  private positionConnectorHandles(conn: ConnectorObject): void {
    const wrap = this.ensureConnectorHandles();
    const s = this.stage.scaleX();
    const ox = this.stage.x();
    const oy = this.stage.y();
    for (const which of ["from", "to"] as const) {
      const p = this.resolveConnectorEnd(which === "from" ? conn.from : conn.to);
      const el = wrap.querySelector<HTMLElement>(`[data-which="${which}"]`);
      if (el) {
        el.style.left = `${p.x * s + ox}px`;
        el.style.top = `${p.y * s + oy}px`;
      }
    }
  }

  private clearConnectorSelection(): void {
    if (!this.selectedConnectors.size) return;
    this.selectedConnectors.clear();
    this.refreshConnectorSelection();
    this.connectorLayer.batchDraw();
  }

  /** Apply a style change to the single selected connector (from the edit bar). */
  private styleSelectedConnector(s: Parameters<typeof setConnectorStyle>[2]): void {
    const id = this.soleSelectedConnector();
    if (id) setConnectorStyle(this.opts.doc, id, s);
  }

  /** Show + position the endpoint handles + the edit bar when exactly one connector is selected. */
  private updateConnectorChrome(): void {
    const id = this.soleSelectedConnector();
    if (!id) {
      if (this.connectorHandlesEl) this.connectorHandlesEl.style.display = "none";
      this.connectorBar.hide();
      return;
    }
    const m = this.objects.get(id);
    const obj = m ? readObject(m) : null;
    if (obj?.type !== "connector") return;
    this.ensureConnectorHandles().style.display = "";
    this.positionConnectorHandles(obj);
    // The edit bar: reflect the connector's style + sit above its screen bounding box.
    this.connectorBar.show({
      color: obj.color,
      width: obj.width,
      style: obj.style,
      startCap: obj.startCap,
      endCap: obj.endCap,
    });
    this.connectorBar.positionAt(this.connectorScreenRect(obj));
  }

  /** The connector's polyline bounding box in screen (page) coords — where the edit bar anchors. */
  private connectorScreenRect(conn: ConnectorObject): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const pts = this.connectorPolyline(conn.kind, conn.from, conn.to);
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      minX = Math.min(minX, pts[i]!);
      maxX = Math.max(maxX, pts[i]!);
      minY = Math.min(minY, pts[i + 1]!);
      maxY = Math.max(maxY, pts[i + 1]!);
    }
    const rect = this.stage.container().getBoundingClientRect();
    const s = this.stage.scaleX();
    const ox = this.stage.x() + rect.left;
    const oy = this.stage.y() + rect.top;
    return {
      x: minX * s + ox,
      y: minY * s + oy,
      width: (maxX - minX) * s,
      height: (maxY - minY) * s,
    };
  }

  // ---- connector body move: drag a selected connector to reposition it (rigid; detaches bound ends
  //      so it can actually move — a connector bound on both ends would otherwise be pinned) ----

  /** Begin dragging the selected connectors as free bodies. During a GROUP move, `skipBoundTo` holds
   *  the selected shape ids: a connector bound to one of them is left out — it follows that shape via
   *  live re-routing instead, so it stays attached rather than being detached into free points. */
  private beginConnectorMove(skipBoundTo?: Set<string>): void {
    const origins = new Map<
      string,
      { a: { x: number; y: number }; b: { x: number; y: number }; conn: ConnectorObject }
    >();
    for (const id of this.selectedConnectors) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type !== "connector") continue;
      if (
        skipBoundTo &&
        ((obj.from.shapeId != null && skipBoundTo.has(obj.from.shapeId)) ||
          (obj.to.shapeId != null && skipBoundTo.has(obj.to.shapeId)))
      )
        continue; // bound to a moving shape → re-routes with it; don't move (and free) it here
      origins.set(id, {
        a: this.resolveConnectorEnd(obj.from),
        b: this.resolveConnectorEnd(obj.to),
        conn: obj,
      });
    }
    if (!origins.size) return; // nothing to move as a free body (all bound connectors re-route)
    const p = this.point();
    this.connectorMove = { startX: p.x, startY: p.y, origins, moved: false };
  }
  /** The moved connector with both ends as free points at their start position + the drag delta. */
  private movedConnectorDraft(
    o: { a: { x: number; y: number }; b: { x: number; y: number }; conn: ConnectorObject },
    dx: number,
    dy: number,
  ): ConnectorObject {
    return {
      ...o.conn,
      from: { x: o.a.x + dx, y: o.a.y + dy },
      to: { x: o.b.x + dx, y: o.b.y + dy },
    };
  }
  private updateConnectorMove(): void {
    const cm = this.connectorMove;
    if (!cm) return;
    const p = this.point();
    const dx = p.x - cm.startX;
    const dy = p.y - cm.startY;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) cm.moved = true;
    let last: ConnectorObject | null = null;
    for (const [id, o] of cm.origins) {
      const group = this.connectorNodes.get(id);
      if (!group) continue;
      const draft = this.movedConnectorDraft(o, dx, dy);
      this.drawConnector(group, draft, SELECT_BLUE);
      last = draft;
    }
    this.connectorLayer.batchDraw();
    if (cm.origins.size === 1 && last) this.positionConnectorHandles(last);
    if (last) this.broadcastConnectorEdit(last); // stream the live move to peers (throttled)
  }
  private endConnectorMove(): void {
    const cm = this.connectorMove;
    this.connectorMove = null;
    if (!cm || !cm.moved) {
      this.broadcastConnectorEdit(null); // nothing moved → just drop the (unused) live preview
      return;
    }
    const p = this.point();
    const dx = p.x - cm.startX;
    const dy = p.y - cm.startY;
    // Commit the doc FIRST, then clear the live preview. Peers apply the doc update before the
    // awareness clear, so they reveal the committed copy already at its final position — clearing
    // first would briefly reveal it at the pre-drag position (the "flash back" flicker on release).
    this.opts.doc.transact(() => {
      for (const [id, o] of cm.origins) {
        const d = this.movedConnectorDraft(o, dx, dy);
        setConnectorEnds(this.opts.doc, id, { from: d.from, to: d.to }); // both ends now free
      }
    });
    this.broadcastConnectorEdit(null);
  }

  // ---- live connector edits over awareness (draw / move / endpoint drag) ----

  /** Stream the in-progress connector to peers (ephemeral; the doc commits on release). Throttled
   *  like cursors; a null draft (release) always goes out immediately. */
  private broadcastConnectorEdit(draft: ConnectorObject | null): void {
    if (draft) {
      const now = Date.now();
      if (now - this.lastConnectorSent < 1000 / CURSOR_HZ) return;
      this.lastConnectorSent = now;
    }
    this.opts.awareness.setLocalStateField(
      "connector",
      draft
        ? {
            id: draft.id,
            kind: draft.kind,
            from: draft.from,
            to: draft.to,
            color: draft.color,
            width: draft.width,
            style: draft.style,
            startCap: draft.startCap,
            endCap: draft.endCap,
          }
        : null,
    );
  }

  /** Validate an untrusted peer connector-edit payload into a renderable connector (or null). */
  private readRemoteConnector(cd: unknown): ConnectorObject | null {
    if (!cd || typeof cd !== "object") return null;
    const o = cd as Record<string, unknown>;
    const readEnd = (e: unknown): ConnectorEnd | null => {
      if (!e || typeof e !== "object") return null;
      const r = e as Record<string, unknown>;
      if (typeof r.x !== "number" || !isFinite(r.x)) return null;
      if (typeof r.y !== "number" || !isFinite(r.y)) return null;
      const end: ConnectorEnd = { x: r.x, y: r.y };
      const side = r.side;
      if (
        typeof r.shapeId === "string" &&
        (side === "top" || side === "right" || side === "bottom" || side === "left")
      ) {
        end.shapeId = r.shapeId;
        end.side = side;
      }
      return end;
    };
    const from = readEnd(o.from);
    const to = readEnd(o.to);
    if (!from || !to || typeof o.id !== "string") return null;
    const caps: ConnectorCap[] = ["none", "line", "arrow", "triangle", "circle", "diamond"];
    const cap = (v: unknown, fb: ConnectorCap): ConnectorCap =>
      caps.includes(v as ConnectorCap) ? (v as ConnectorCap) : fb;
    const kinds = ["line", "arrow", "elbow", "block"];
    return {
      id: o.id,
      type: "connector",
      kind: kinds.includes(o.kind as string) ? (o.kind as ConnectorKind) : "arrow",
      from,
      to,
      color: typeof o.color === "string" ? o.color : DEFAULT_CONNECTOR_COLOR,
      width: typeof o.width === "number" && o.width > 0 ? o.width : DEFAULT_CONNECTOR_WIDTH,
      style: o.style === "dashed" ? "dashed" : "solid",
      startCap: cap(o.startCap, "none"),
      endCap: cap(o.endCap, "arrow"),
      authorId: "",
    };
  }

  /** Sync peers' in-progress connector edits from awareness: update interpolation targets, manage the
   *  preview groups, and hide the committed copies. Idle (nobody editing) is a cheap early-out — no
   *  redraw — so cursor-tick awareness churn doesn't repaint the connector layer. */
  private renderRemoteConnectors(): void {
    const local = this.opts.awareness.clientID;
    const edited = new Set<string>();
    const seen = new Set<number>();
    this.opts.awareness.getStates().forEach((state, cid) => {
      if (cid === local) return;
      const conn = this.readRemoteConnector((state as Record<string, unknown>)["connector"]);
      if (!conn) return;
      seen.add(cid);
      edited.add(conn.id);
      const ta = this.resolveConnectorEnd(conn.from);
      const tb = this.resolveConnectorEnd(conn.to);
      const rc = this.remoteConn.get(cid);
      if (rc) {
        rc.conn = conn;
        rc.ta = ta;
        rc.tb = tb;
      } else {
        const group = new Konva.Group({ listening: false });
        this.connectorLayer.add(group);
        this.remoteConn.set(cid, { group, conn, ta, tb, ca: { ...ta }, cb: { ...tb } });
        // Draw it now (at the target, where the glide starts) instead of waiting for the next RAF:
        // we hide the committed copy below in this same pass, so an empty group would leave the
        // connector blank for one painted frame (the start-of-drag flash).
        this.drawConnector(group, { ...conn, from: ta, to: tb }, this.connectorSelColor(conn.id));
      }
    });
    // idle: nothing live now and nothing to tear down → no redraw at all
    if (!seen.size && !this.remoteConn.size && !this.remoteConnectorIds.size) return;
    for (const [cid, rc] of this.remoteConn) {
      if (seen.has(cid)) continue;
      rc.group.destroy();
      this.remoteConn.delete(cid);
    }
    // committed-copy visibility — only touch it (and redraw) when the edited-id set actually changes
    const changed =
      edited.size !== this.remoteConnectorIds.size ||
      [...edited].some((id) => !this.remoteConnectorIds.has(id));
    if (changed) {
      this.remoteConnectorIds.clear();
      edited.forEach((id) => this.remoteConnectorIds.add(id));
      for (const [id, group] of this.connectorNodes)
        group.visible(!this.remoteConnectorIds.has(id));
    }
    if (this.remoteConn.size) this.ensureConnGlide();
    else this.connectorLayer.batchDraw(); // last preview just went away
  }

  private ensureConnGlide(): void {
    if (!this.connGlideRaf) this.connGlideRaf = requestAnimationFrame(this.connGlideStep);
  }
  /** Interpolate each remote connector's endpoints toward its target (LERP, like the stroke/shape
   *  glide) and redraw — so peers' connector edits move smoothly between 30 Hz broadcasts. */
  private readonly connGlideStep = (): void => {
    this.connGlideRaf = 0;
    let active = false;
    for (const rc of this.remoteConn.values()) {
      rc.ca.x += (rc.ta.x - rc.ca.x) * LERP;
      rc.ca.y += (rc.ta.y - rc.ca.y) * LERP;
      rc.cb.x += (rc.tb.x - rc.cb.x) * LERP;
      rc.cb.y += (rc.tb.y - rc.cb.y) * LERP;
      const settled =
        Math.abs(rc.ta.x - rc.ca.x) < 0.5 &&
        Math.abs(rc.ta.y - rc.ca.y) < 0.5 &&
        Math.abs(rc.tb.x - rc.cb.x) < 0.5 &&
        Math.abs(rc.tb.y - rc.cb.y) < 0.5;
      if (settled) {
        rc.ca = { ...rc.ta };
        rc.cb = { ...rc.tb };
      } else {
        active = true;
      }
      // draw between the interpolated endpoints (free points) in the connector's own colour, but keep
      // the selecting peer's halo on it: the committed, tinted copy is hidden while it's being edited
      // (remoteConnectorIds), so without re-applying the selection colour here the highlight would
      // vanish on every peer's screen the instant the drag starts.
      this.drawConnector(
        rc.group,
        { ...rc.conn, from: { x: rc.ca.x, y: rc.ca.y }, to: { x: rc.cb.x, y: rc.cb.y } },
        this.connectorSelColor(rc.conn.id),
      );
    }
    this.connectorLayer.batchDraw();
    if (active) this.ensureConnGlide();
  };

  // ---- selection (marquee + click select, move, resize) ----
  private bindSelection(): void {
    this.stage.on("pointerdown", (e) => {
      if (this.tool !== "select") return;
      this.hidePeerTip(); // a press starts an interaction → drop the hover tooltip
      this.cancelMarquee(); // drop any marquee orphaned by a missed pointerup before starting fresh
      const shift = (e.evt as PointerEvent).shiftKey;
      // Text lives in the HTML overlay (not the Konva hit graph), so hit-test it first.
      const tid = this.textLayer.hitTest(this.point());
      // Group rotate: pressing just outside a group corner rotates the whole selection (no handle).
      // ADR-0009 P3 Step 4: the rotation is driven by the text-layer's DOM group chrome; the canvas
      // just owns the band detection (rotationCornerOf) and hands off the gesture.
      if (!shift && this.rotationCornerOf(this.point())) {
        this.textLayer.beginGroupRotate(e.evt as PointerEvent);
        return;
      }
      // Group move: a multi-node selection drags as one unit. Pressing on a SELECTED member, or on the
      // empty space inside the selection box, moves every selected node (strokes + text + connectors)
      // together. A press on an unselected node, or outside the box, falls through to normal select.
      // (Shift extends the selection; transform handles were already intercepted above.)
      if (!shift && this.isGroupSelection()) {
        const hitId = tid ?? this.objIdOf(e.target);
        const u = this.selectionUnionRect();
        const onSelected = hitId != null && this.isSelectedAny(hitId);
        const inEmptySpace =
          hitId == null && !!u && pointInRect(this.point(), u, this.viewport.screenPx(6));
        if (onSelected || inEmptySpace) {
          this.beginGroupMove();
          return;
        }
      }
      if (tid) {
        // Two-click: a QUICK second tap on the already-sole-selected box edits it (fired on release
        // if it stayed a tap — a drag instead moves the box). A slow click just re-selects, so you
        // can always re-select a box you picked a while ago instead of dropping into its text.
        const p = this.point();
        const TWO_CLICK_MS = 700;
        const alreadySole =
          !shift &&
          this.selected.size === 0 &&
          !this.textLayer.isStampId(tid) && // a stamp isn't text-editable → no two-click-to-edit
          !this.textLayer.isInkId(tid) && // nor is a stroke (ADR-0009 P3)
          this.textLayer.isSelected(tid) &&
          this.textLayer.selectedIds().length === 1;
        const recent =
          !!this.textSelectAt &&
          this.textSelectAt.id === tid &&
          Date.now() - this.textSelectAt.t < TWO_CLICK_MS;
        if (!shift) this.clearSelection(); // drop stroke selection (clearSelection also clears text)
        if (shift || !this.textLayer.isSelected(tid)) this.textLayer.selectText(tid, shift);
        this.textLayer.beginMove(this.point());
        const edit = alreadySole && recent;
        this.textTapEdit = edit ? { id: tid, x: p.x, y: p.y } : null;
        this.textSelectAt = edit ? null : { id: tid, t: Date.now() }; // record/restart the window
        return;
      }
      this.textTapEdit = null;
      this.textSelectAt = null;
      // Resolve the hit object id BEFORE clearing the connector selection. clearConnectorSelection()
      // re-renders connectors via drawConnector → group.destroyChildren(), which detaches e.target;
      // calling objIdOf(e.target) afterwards would then walk an orphaned node (getParent() === null)
      // and return null. That turned a press on an already-selected connector into a deselect +
      // marquee — the "I can't click-then-drag a line, only one quick motion works" bug.
      const id = this.objIdOf(e.target);
      if (!shift) {
        this.textLayer.clearSelection(); // clicking strokes/empty drops the text + connector selection
        this.clearConnectorSelection();
      }
      if (id && this.connectorNodes.has(id)) {
        // The DOM hit-test narrowly missed a connector that the Konva node caught → select it in the
        // text layer (the unified path), same as a `tid` hit. ADR-0009 P3.
        if (shift || !this.textLayer.isSelected(id)) this.textLayer.selectText(id, shift);
        this.textLayer.beginMove(this.point());
        return;
      }
      if (id) {
        if (shift) {
          if (this.selected.has(id)) this.selected.delete(id);
          else this.selected.add(id);
          this.reattachTransformer();
          if (this.selected.has(id)) this.beginMove();
        } else {
          if (!this.selected.has(id)) this.setSelection([id]);
          this.beginMove();
        }
      } else {
        if (!shift) this.clearSelection();
        this.beginMarquee(shift);
      }
    });
    this.stage.on("pointermove", () => {
      if (this.textTapEdit) {
        const p = this.point();
        const d = Math.hypot(p.x - this.textTapEdit.x, p.y - this.textTapEdit.y);
        if (d > this.textLayer.tapSlop()) this.textTapEdit = null; // became a drag → move, don't edit
      }
      if (this.groupMoving) this.updateGroupMove();
      else if (this.textLayer.isMoving()) this.textLayer.moveTo(this.point());
      else if (this.moveState) this.updateMove();
      else if (this.connectorMove) this.updateConnectorMove();
      else if (this.marquee) this.updateMarquee();
      else if (this.tool === "select" && !this.resizing) {
        // Idle hover: a "who selected this" tooltip over another user's selection + the cursor
        // (rotate near a group corner, normal otherwise).
        this.updateSelectHover(this.point());
      } else this.hidePeerTip();
    });
    this.stage.on("pointerup", this.onWindowPointerUp);
    // A release that lands outside the stage still ends the gesture.
    window.addEventListener("pointerup", this.onWindowPointerUp);
    // (Editing is driven by the windowed two-click above — a quick second tap on a selected box —
    // which also covers native double-clicks, so no separate dblclick handler is needed.)
  }

  /** Walk up from a hit node to its owning object id (null for empty canvas). */
  private objIdOf(node: Konva.Node): string | null {
    let n: Konva.Node | null = node;
    while (n && n !== this.stage) {
      const id = n.getAttr(OBJ_ID_ATTR);
      if (typeof id === "string") return id;
      n = n.getParent();
    }
    return null;
  }

  private setSelection(ids: string[]): void {
    this.selected.clear();
    for (const id of ids) {
      if (this.nodeById.has(id)) this.selected.add(id);
    }
    this.reattachTransformer();
  }
  clearSelection(): void {
    this.textLayer.clearSelection();
    if (this.selectedConnectors.size) {
      this.selectedConnectors.clear();
      this.refreshConnectorSelection();
      this.connectorLayer.batchDraw();
    }
    if (!this.selected.size) return;
    this.selected.clear();
    this.reattachTransformer();
  }
  /** Select every object on the board (⌘A). */
  selectAll(): void {
    this.setSelection([]); // strokes select via the text-layer now (ADR-0009 P3); canvas.selected unused
    this.textLayer.selectAll();
    for (const id of this.connectorNodes.keys()) this.selectedConnectors.add(id);
    this.refreshConnectorSelection();
    this.connectorLayer.batchDraw();
    // All subsystems settled — re-evaluate the transform box vs the union group box (a board with any
    // non-stroke object makes ⌘A a mixed selection → union box, transform box detached) and redraw it.
    this.reattachTransformer();
  }
  deleteSelection(): void {
    this.textLayer.deleteSelected();
    const connIds = [...this.selectedConnectors];
    this.selectedConnectors.clear();
    if (connIds.length) deleteObjects(this.opts.doc, connIds); // observer re-renders without them
    if (!this.selected.size) return;
    const ids = [...this.selected];
    this.selected.clear();
    deleteObjects(this.opts.doc, ids); // observer re-renders; reattach drops the gone ids
  }

  /** Copy the current selection (strokes + connectors + text/shapes) into the in-app clipboard. */
  copySelection(): void {
    const ids = [...this.selected, ...this.selectedConnectors, ...this.textLayer.selectedIds()];
    if (!ids.length) return; // nothing selected → keep whatever's already on the clipboard
    const objs: BoardObject[] = [];
    for (const id of ids) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj) objs.push(obj);
    }
    if (!objs.length) return;
    this.clipboard = objs;
    this.pasteCount = 0;
  }

  /** Paste the clipboard: clone each object with a fresh id + a cascading offset (a copied connector
   *  rebinds to its copied shapes), commit in one transaction, then select the new copies. No-op when
   *  the clipboard is empty. */
  pasteSelection(): void {
    if (!this.clipboard.length) return;
    this.pasteCount += 1;
    const off = 24 * this.pasteCount; // cascade offset (canvas units) so repeated paste doesn't stack
    const author = String(this.opts.awareness.clientID);
    // Map every copied id → its new id FIRST, so a connector copied with its shapes rebinds to the copies.
    const idMap = new Map<string, string>();
    for (const o of this.clipboard) {
      const prefix = o.type === "stroke" ? "st" : o.type === "connector" ? "cn" : "tx";
      idMap.set(o.id, randomId(prefix));
    }
    const clones = this.clipboard.map((o) =>
      cloneObject(o, idMap.get(o.id) ?? randomId("o"), author, off, off, idMap),
    );
    this.opts.doc.transact(() => {
      for (const c of clones) addObject(this.opts.doc, c);
    });
    // The transaction's observers re-rendered synchronously, so the new nodes now exist — select them.
    this.selectPasted(clones);
  }

  /** Select freshly-pasted objects across all three selection subsystems (strokes / text / connectors). */
  private selectPasted(clones: BoardObject[]): void {
    this.clearSelection();
    const strokeIds = clones.filter((o) => o.type === "stroke").map((o) => o.id);
    const textIds = clones.filter((o) => o.type === "text").map((o) => o.id);
    const connIds = clones.filter((o) => o.type === "connector").map((o) => o.id);
    if (strokeIds.length) this.setSelection(strokeIds); // strokes → transformer + notify + publish
    for (const id of textIds) this.textLayer.selectText(id, true); // additive
    for (const id of connIds) if (this.connectorNodes.has(id)) this.selectedConnectors.add(id);
    if (connIds.length) {
      this.refreshConnectorSelection();
      this.connectorLayer.batchDraw();
    }
    this.notifySelection();
    this.publishSelection();
  }
  hasSelection(): boolean {
    return (
      this.selected.size > 0 || this.selectedConnectors.size > 0 || this.textLayer.hasSelection()
    );
  }

  /** Rotate the current selection by `delta` degrees about each object's own centre (the [ / ] keyboard
   *  nudge). Shapes/stickies/text spin via a stored angle (text layer); strokes bake the rotation into
   *  their points and connectors into their endpoints (a rotated connector detaches from any shape). */
  rotateSelection(delta: number): void {
    this.textLayer.rotateSelected(delta);
    const rad = (delta * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const spin = (px: number, py: number, cx: number, cy: number): { x: number; y: number } => ({
      x: cx + (px - cx) * cos - (py - cy) * sin,
      y: cy + (px - cx) * sin + (py - cy) * cos,
    });
    const strokeUpdates: { id: string; points: number[] }[] = [];
    for (const id of this.selected) {
      const obj = readObject(this.objects.get(id)!);
      if (obj?.type !== "stroke") continue;
      const b = this.strokeBBox(obj);
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const pts: number[] = [];
      for (let i = 0; i + 1 < obj.points.length; i += 2) {
        const p = spin(obj.points[i]!, obj.points[i + 1]!, cx, cy);
        pts.push(p.x, p.y);
      }
      strokeUpdates.push({ id, points: pts });
    }
    const connUpdates: {
      id: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
    }[] = [];
    for (const id of this.selectedConnectors) {
      const obj = readObject(this.objects.get(id)!);
      if (obj?.type !== "connector") continue;
      if (obj.from.shapeId || obj.to.shapeId) continue; // snapped to a shape → rotating it (and thus
      // detaching it) makes no sense; leave it anchored.
      const a = this.resolveConnectorEnd(obj.from);
      const z = this.resolveConnectorEnd(obj.to);
      const cx = (a.x + z.x) / 2;
      const cy = (a.y + z.y) / 2;
      connUpdates.push({ id, from: spin(a.x, a.y, cx, cy), to: spin(z.x, z.y, cx, cy) });
    }
    if (!strokeUpdates.length && !connUpdates.length) return;
    this.opts.doc.transact(() => {
      if (strokeUpdates.length) setObjectsPoints(this.opts.doc, strokeUpdates);
      for (const u of connUpdates)
        setConnectorEnds(this.opts.doc, u.id, { from: u.from, to: u.to });
    });
  }
  /** Test/debug hook: how many remote-peer selection outlines are currently drawn. */
  remoteSelectionCount(): number {
    return this.remoteSelections.getChildren().length;
  }
  /** Test/debug hook: how many remote-peer in-progress stroke previews are currently drawn. */
  remoteDrawCount(): number {
    return this.remoteDraws.size;
  }
  /** Test/debug hook: the screen-space (container-relative) centre of a transformer anchor
   *  (e.g. "bottom-right"), or null if nothing is selected. */
  transformerAnchorPos(name: string): { x: number; y: number } | null {
    // ADR-0009 P3 Step 4: every selection resizes via the text-layer's DOM chrome. For a multi-node
    // group use the group box's handle; otherwise the single box's handle (the other chrome is hidden).
    const corner = (
      { "top-left": "nw", "top-right": "ne", "bottom-left": "sw", "bottom-right": "se" } as Record<
        string,
        string | undefined
      >
    )[name];
    if (!corner) return null;
    const group = this.textLayer.selectedCount() >= 2;
    const handle = document.querySelector<HTMLElement>(
      group ? `.co-group-handle.g-${corner}` : `.co-text-handle.h-${corner}`,
    );
    if (!handle) return null;
    const hr = handle.getBoundingClientRect();
    const ref = (
      document.getElementById("board") ?? this.stage.container()
    ).getBoundingClientRect();
    return { x: hr.x + hr.width / 2 - ref.x, y: hr.y + hr.height / 2 - ref.y };
  }
  /** Test/debug hook: a rendered object's content-relative bounding rect (null if not drawn). */
  nodeContentRect(id: string): Rect | null {
    // ADR-0009 P3: ink + DOM objects live in the text-layer; its world rect honours live previews
    // (a peer's in-progress resize), which the old Konva node rect did not.
    const textRect = this.textLayer.worldRectOf(id);
    if (textRect) return textRect;
    const node = this.nodeById.get(id);
    return node ? node.getClientRect({ relativeTo: node.getLayer() ?? this.content }) : null;
  }
  /** Test/debug hook: total object nodes vs. how many are currently drawn (viewport-culling check). */
  drawnNodeCount(): { total: number; visible: number } {
    let visible = 0;
    for (const node of this.nodeById.values()) if (node.visible()) visible++;
    return { total: this.nodeById.size, visible };
  }
  /** Undo / redo your own edits (remote edits are untracked, so they're never reverted). */
  undo(): void {
    this.undoManager.undo();
  }
  redo(): void {
    this.undoManager.redo();
  }
  setSelectionListener(cb: (count: number) => void): void {
    this.selectionListener = cb;
    this.notifySelection();
  }
  private notifySelection(): void {
    const count =
      this.selected.size + this.selectedConnectors.size + this.textLayer.selectedCount();
    this.textLayer.setGroupSelected(count >= 2); // hide a shape's snap dots inside a multi-node group
    this.selectionListener?.(count);
  }

  /**
   * Broadcast my selected object ids on the awareness channel so peers can outline
   * them. Cleared to null when empty; skips the broadcast when the set is unchanged
   * (reattachTransformer runs on every render, including unrelated remote edits).
   */
  private publishSelection(): void {
    // strokes + connectors + text so peers outline everything I've selected
    const ids = [...this.selected, ...this.selectedConnectors, ...this.textLayer.selectedIds()];
    const key = ids.slice().sort().join(",");
    if (key === this.lastPublishedSelection) return;
    // A live marquee resolves the selection on every pointermove; cap that broadcast
    // rate (as we do for cursors). endMarquee clears this.marquee *before* its final
    // applyMarquee, so the settled selection always goes out immediately — peers converge
    // exactly, they just see fewer intermediate frames while the band is still moving.
    if (this.marquee) {
      const now = Date.now();
      if (now - this.lastSelectionSent < 1000 / CURSOR_HZ) return;
      this.lastSelectionSent = now;
    }
    this.lastPublishedSelection = key;
    this.opts.awareness.setLocalStateField("selection", ids.length ? ids : null);
  }

  /** Reconcile selection chrome after every render: prune ids whose nodes vanished, then redraw the
   *  selection outlines and republish. (Named for the retired Konva.Transformer it once drove; the
   *  transform box itself is now the text-layer's DOM chrome — see the P3 Step 4 note below.) */
  private reattachTransformer(): void {
    for (const id of [...this.selected]) if (!this.nodeById.has(id)) this.selected.delete(id);
    // ADR-0009 P3 Step 4: every object (single OR group) resizes/rotates via the text-layer's DOM
    // chrome — the Konva transformer/proxy is never attached. notifySelection() drives the text-layer
    // to show its single-box or multi-node group transform box for the current selection.
    this.renderSelectionBoxes();
    this.notifySelection();
    this.publishSelection();
  }

  private beginMove(): void {
    const p = this.point();
    this.moveState = { startX: p.x, startY: p.y, dx: 0, dy: 0 };
    this.stage.container().style.cursor = "move";
  }
  private updateMove(): void {
    if (!this.moveState) return;
    const p = this.point();
    this.moveState.dx = p.x - this.moveState.startX;
    this.moveState.dy = p.y - this.moveState.startY;
    for (const id of this.selected) {
      this.nodeById.get(id)?.position({ x: this.moveState.dx, y: this.moveState.dy });
    }
    this.renderSelectionBoxes();
    this.content.batchDraw();
    // Stream the in-progress move to peers (throttled like cursors). The doc only commits
    // on release (endMove), so this preview is ephemeral — no undo/persistence churn. Suppressed
    // during a group move: updateGroupMove sends ONE unified "drag" for all stroke + text ids.
    const now = Date.now();
    if (!this.groupMoving && now - this.lastDragSent >= 1000 / CURSOR_HZ) {
      this.lastDragSent = now;
      this.opts.awareness.setLocalStateField("drag", {
        ids: [...this.selected],
        dx: this.moveState.dx,
        dy: this.moveState.dy,
      });
    }
  }
  private endMove(): void {
    const m = this.moveState;
    this.moveState = null;
    this.stage.container().style.cursor = this.tool === "select" ? CURSOR_URL : "grab";
    // Commit the move to the doc first (peers re-render at the baked coords), then stop the
    // live preview — this ordering lets the committed geometry land before the offset clears.
    if (m && (Math.abs(m.dx) >= 0.01 || Math.abs(m.dy) >= 0.01)) {
      this.opts.doc.transact(() => {
        if (this.selected.size) translateObjects(this.opts.doc, [...this.selected], m.dx, m.dy);
      });
    }
    this.opts.awareness.setLocalStateField("drag", null);
  }

  // ---- group move: drag a whole multi-node selection (any mix of types) as one unit ----
  /** Whether the current selection spans 2+ nodes across all subsystems (so it has a group box). */
  private isGroupSelection(): boolean {
    return this.selected.size + this.textLayer.selectedCount() + this.selectedConnectors.size >= 2;
  }
  /** Whether `id` belongs to the current selection, whatever its type. */
  private isSelectedAny(id: string): boolean {
    return (
      this.selected.has(id) || this.textLayer.isSelected(id) || this.selectedConnectors.has(id)
    );
  }
  private beginGroupMove(): void {
    const p = this.point();
    this.groupMoving = true;
    this.groupMoveStart = { x: p.x, y: p.y };
    if (this.selected.size) this.beginMove(); // strokes
    if (this.textLayer.selectedCount()) this.textLayer.beginMove(p); // text / sticky / shape
    // Connectors move as free bodies, EXCEPT those bound to a selected shape — they re-route with it.
    if (this.selectedConnectors.size)
      this.beginConnectorMove(new Set(this.textLayer.selectedIds()));
    this.stage.container().style.cursor = "move";
  }
  private updateGroupMove(): void {
    const p = this.point();
    if (this.moveState) this.updateMove(); // strokes (its own peer broadcast is suppressed)
    if (this.textLayer.isMoving()) this.textLayer.moveTo(p, false); // text (broadcast suppressed)
    if (this.connectorMove) this.updateConnectorMove(); // connectors (own awareness field)
    this.renderSelectionBoxes(); // faint per-stroke outlines follow the moving strokes
    // The DOM group box tracks the moving union via textLayer.moveTo → updateGroupChrome.
    // One unified live "drag" for every stroke + text id (same shared delta) so peers move the whole
    // group together — the per-subsystem broadcasts above are suppressed so they don't overwrite it.
    if (!this.groupMoveStart) return;
    const dx = p.x - this.groupMoveStart.x;
    const dy = p.y - this.groupMoveStart.y;
    const now = Date.now();
    if (now - this.lastDragSent >= 1000 / CURSOR_HZ) {
      this.lastDragSent = now;
      const ids = [...this.selected, ...this.textLayer.selectedIds()];
      this.opts.awareness.setLocalStateField("drag", ids.length ? { ids, dx, dy } : null);
    }
  }
  private endGroupMove(): void {
    this.groupMoving = false;
    this.groupMoveStart = null;
    // Commit every subsystem in ONE transaction so undo reverts the whole group move in a single step.
    this.opts.doc.transact(() => {
      if (this.moveState) this.endMove();
      if (this.textLayer.isMoving()) this.textLayer.endMove();
      if (this.connectorMove) this.endConnectorMove();
    });
    this.opts.awareness.setLocalStateField("drag", null); // clear the unified live preview
    this.stage.container().style.cursor = this.tool === "select" ? CURSOR_URL : "grab";
  }

  /** Which corner (if any) a point falls into the rotate-band of — a corner-drag just outside a
   *  multi-selection's union box rotates the whole group (single boxes use the text layer's own
   *  rotate handles). Returns null for an empty or single-object selection. */
  private rotationCornerOf(world: { x: number; y: number }): RotateCorner | null {
    if (this.selected.size === 0 && !this.isGroupSelection()) return null;
    const u = this.selectionUnionRect();
    if (!u) return null;
    // Start the rotate band just BEYOND the resize anchors (~11px out) so the two don't fight, and
    // give it a generous reach so it's easy to grab.
    const pad = this.viewport.screenPx(11);
    if (
      world.x > u.x - pad &&
      world.x < u.x + u.width + pad &&
      world.y > u.y - pad &&
      world.y < u.y + u.height + pad
    )
      return null;
    const reach = this.viewport.screenPx(38);
    const corners: [RotateCorner, number, number][] = [
      ["nw", u.x, u.y],
      ["ne", u.x + u.width, u.y],
      ["sw", u.x, u.y + u.height],
      ["se", u.x + u.width, u.y + u.height],
    ];
    let best: RotateCorner | null = null;
    let bestD = reach;
    for (const [name, cx, cy] of corners) {
      const d = Math.hypot(world.x - cx, world.y - cy);
      if (d <= bestD) {
        bestD = d;
        best = name;
      }
    }
    return best;
  }

  private beginMarquee(additive: boolean): void {
    const p = this.point();
    this.marqueeStart = p;
    this.marqueeBase = new Set(additive ? [...this.selected] : []);
    this.marqueeAdditive = additive;
    this.marquee = new Konva.Rect({
      x: p.x,
      y: p.y,
      width: 0,
      height: 0,
      fill: "rgba(74, 158, 255, 0.12)",
      stroke: SELECT_BLUE,
      strokeWidth: this.viewport.screenPx(1),
      listening: false,
    });
    this.uiLayer.add(this.marquee);
    this.marquee.moveToBottom();
  }
  private updateMarquee(): void {
    if (!this.marquee || !this.marqueeStart) return;
    const p = this.point();
    const s = this.marqueeStart;
    const box: Rect = {
      x: Math.min(p.x, s.x),
      y: Math.min(p.y, s.y),
      width: Math.abs(p.x - s.x),
      height: Math.abs(p.y - s.y),
    };
    this.marquee.setAttrs(box);
    this.applyMarquee(box); // show the resulting selection live, before release
  }
  private endMarquee(): void {
    if (!this.marquee) return;
    const box: Rect = {
      x: this.marquee.x(),
      y: this.marquee.y(),
      width: this.marquee.width(),
      height: this.marquee.height(),
    };
    this.cancelMarquee();
    this.applyMarquee(box);
  }
  private applyMarquee(box: Rect): void {
    // Strokes are text-layer objects now (ADR-0009 P3) → marquee-selected via selectInBox below, not
    // the Konva hit graph; canvas.selected only carries marqueeBase (legacy, normally empty).
    const hits = new Set(this.marqueeBase);
    this.setSelection([...hits]);
    this.textLayer.selectInBox(box, this.marqueeAdditive); // text/strokes aren't Konva nodes — select separately
    this.selectConnectorsInBox(box); // connectors aren't in nodeById — test their polyline bbox
    // All three subsystems are settled now — re-evaluate the transform box vs the union group box and
    // redraw it (setSelection ran before text/connectors were known, so its box pass was incomplete).
    this.reattachTransformer();
  }

  /** Add connectors whose polyline bounding box intersects the marquee (world coords). */
  private selectConnectorsInBox(box: Rect): void {
    if (!this.marqueeAdditive)
      for (const id of [...this.selectedConnectors]) this.selectedConnectors.delete(id);
    if (box.width >= 2 || box.height >= 2) {
      for (const id of this.connectorNodes.keys()) {
        const m = this.objects.get(id);
        const obj = m ? readObject(m) : null;
        if (obj?.type !== "connector") continue;
        const pts = this.connectorPolyline(obj.kind, obj.from, obj.to);
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (let i = 0; i + 1 < pts.length; i += 2) {
          minX = Math.min(minX, pts[i]!);
          maxX = Math.max(maxX, pts[i]!);
          minY = Math.min(minY, pts[i + 1]!);
          maxY = Math.max(maxY, pts[i + 1]!);
        }
        const bb = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        if (rectsIntersect(box, bb)) this.selectedConnectors.add(id);
      }
    }
    this.refreshConnectorSelection();
    this.notifySelection();
    this.publishSelection();
  }
  private cancelMarquee(): void {
    this.marquee?.destroy();
    this.marquee = null;
    this.marqueeStart = null;
    this.uiLayer.batchDraw();
  }

  /** Light-blue per-node outlines for a multi-selection (the union gets the transform box). */
  private renderSelectionBoxes(): void {
    this.highlightGroup.destroyChildren();
    // Faint per-node outlines for any residual multi-node Konva selection. The union transform box
    // is now the text-layer's DOM group chrome (updateGroupChrome), not a Konva transformer/proxy.
    if (this.selected.size > 1) {
      const sw = this.viewport.screenPx(1.2);
      for (const id of this.selected) {
        const node = this.nodeById.get(id);
        if (!node) continue;
        const r = node.getClientRect({ relativeTo: node.getLayer() ?? this.content });
        this.highlightGroup.add(
          new Konva.Rect({
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            stroke: "#8fbcff",
            strokeWidth: sw,
            listening: false,
          }),
        );
      }
    }
    this.uiLayer.batchDraw();
  }

  /**
   * The union of every selected node's world-space AABB — strokes (Konva client rects), text /
   * sticky / shape boxes (live geometry from the text layer), and connector polylines — in
   * content/world coordinates. null when nothing measurable is selected.
   */
  private selectionUnionRect(): Rect | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const fold = (x: number, y: number, w: number, h: number): void => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    };
    for (const id of this.selected) {
      const node = this.nodeById.get(id);
      if (!node) continue;
      const r = node.getClientRect({
        relativeTo: node.getLayer() ?? this.content,
        skipShadow: true,
      });
      fold(r.x, r.y, r.width, r.height);
    }
    for (const r of this.textLayer.selectedWorldRects()) fold(r.x, r.y, r.width, r.height);
    for (const id of this.selectedConnectors) {
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type !== "connector") continue;
      const pts = this.connectorPolyline(obj.kind, obj.from, obj.to);
      for (let i = 0; i + 1 < pts.length; i += 2) fold(pts[i]!, pts[i + 1]!, 0, 0);
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Outline every object each *remote* peer has selected, tinted to their cursor
   * color. Drawn in world space relative to `content`, so the
   * boxes pan/zoom with the board; stroke width is kept a constant screen size.
   */
  private renderRemoteSelections(force = false): void {
    const self = this.opts.awareness.clientID;
    // Gather each peer's (color + selected ids) and a signature of the same. Cursor /
    // name awareness ticks don't change the signature, so those (frequent) changes skip
    // the rebuild. Geometry (move/resize/delete) and zoom aren't in the signature, so
    // those callers pass force=true; node membership only changes via renderObjects,
    // which is one of those forced callers — so the cached path stays correct.
    const peers: { clientId: number; color: string; ids: string[] }[] = [];
    const parts: string[] = [];
    this.opts.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return;
      const ids = state["selection"] as string[] | undefined;
      if (!ids?.length) return;
      const color = String(state["color"] ?? "#2563eb");
      peers.push({ clientId, color, ids });
      parts.push(`${clientId}:${color}:${ids.join(",")}`);
    });
    const key = parts.sort().join("|");
    if (!force && key === this.lastRemoteSelKey) return;
    this.lastRemoteSelKey = key;

    const inv = this.viewport.screenPx(1);
    const pad = 4 * inv;
    const seen = new Set<string>();
    // Reuse one rect per (peer, object): update attrs in place rather than destroy + recreate,
    // so the per-frame outline refresh during an interpolated remote drag/resize is allocation-free.
    const newConnSel = new Map<string, string>(); // connector id → selecting peer's colour
    const seenGroups = new Set<number>();
    for (const { clientId, color, ids } of peers) {
      // A peer-selected connector is shown by re-tinting the connector in their colour (no box) —
      // record it whether the selection is single or a group.
      for (const id of ids) if (this.connectorNodes.has(id)) newConnSel.set(id, color);

      if (ids.length >= 2) {
        // Multi-node selection → ONE group box (in the peer's colour) around the whole union,
        // mirroring the local group/transform box. No per-node rects (the box represents them all).
        const u = this.peerSelectionUnionRect(ids);
        if (u) {
          seenGroups.add(clientId);
          let box = this.remoteSelGroupRects.get(clientId);
          if (!box) {
            box = new Konva.Rect({ listening: false });
            this.remoteSelections.add(box);
            this.remoteSelGroupRects.set(clientId, box);
          }
          box.setAttrs({
            x: u.x - pad * 2,
            y: u.y - pad * 2,
            width: u.width + pad * 4,
            height: u.height + pad * 4,
            stroke: color,
            strokeWidth: 1.5 * inv,
            cornerRadius: 2 * inv,
          });
        }
        continue;
      }

      // Single selection → outline the one stroke (text/shape/sticky/stamp get their ring from the
      // text layer; connectors are ringed separately). Strokes paint as DOM <svg> now, so their world
      // rect comes from the text-layer (ADR-0009 P3 — the Konva stroke pipeline is gone).
      for (const id of ids) {
        if (this.connectorNodes.has(id)) continue;
        const m = this.objects.get(id);
        const o = m ? readObject(m) : null;
        if (o?.type !== "stroke") continue;
        const r = this.textLayer.worldRectOf(id);
        if (!r) continue;
        const rkey = `${clientId}:${id}`;
        seen.add(rkey);
        let rect = this.remoteSelRects.get(rkey);
        if (!rect) {
          rect = new Konva.Rect({ listening: false });
          this.remoteSelections.add(rect);
          this.remoteSelRects.set(rkey, rect);
        }
        rect.setAttrs({
          x: r.x - pad,
          y: r.y - pad,
          width: r.width + pad * 2,
          height: r.height + pad * 2,
          stroke: color,
          strokeWidth: 1.5 * inv,
          cornerRadius: 2 * inv,
        });
      }
    }
    // drop rects for selections that are gone (deselected, deleted, culled, or folded into a group box)
    for (const [rkey, rect] of this.remoteSelRects) {
      if (seen.has(rkey)) continue;
      rect.destroy();
      this.remoteSelRects.delete(rkey);
    }
    // drop group boxes for peers no longer holding a multi-node selection
    for (const [cid, box] of this.remoteSelGroupRects) {
      if (seenGroups.has(cid)) continue;
      box.destroy();
      this.remoteSelGroupRects.delete(cid);
    }
    this.overlay.batchDraw();
    // re-tint connectors only when the peer-selection set actually changed
    const connSelChanged =
      newConnSel.size !== this.remoteConnSel.size ||
      [...newConnSel].some(([id, c]) => this.remoteConnSel.get(id) !== c);
    if (connSelChanged) {
      this.remoteConnSel.clear();
      for (const [id, c] of newConnSel) this.remoteConnSel.set(id, c);
      this.rerouteConnectors();
    }
  }

  /** Union AABB of an arbitrary id list (a peer's selection) across every node type — strokes,
   *  text/sticky/shape, and connectors — in content/world coords. null if none resolve locally. */
  private peerSelectionUnionRect(ids: string[]): Rect | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const fold = (x: number, y: number, w: number, h: number): void => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    };
    for (const id of ids) {
      const node = this.nodeById.get(id);
      if (node && node.visible()) {
        const r = this.nodeRect(id, node);
        fold(r.x, r.y, r.width, r.height);
        continue;
      }
      const tr = this.textLayer.worldRectOf(id);
      if (tr) {
        fold(tr.x, tr.y, tr.width, tr.height);
        continue;
      }
      const m = this.objects.get(id);
      const obj = m ? readObject(m) : null;
      if (obj?.type === "connector") {
        const pts = this.connectorPolyline(obj.kind, obj.from, obj.to);
        for (let i = 0; i + 1 < pts.length; i += 2) fold(pts[i]!, pts[i + 1]!, 0, 0);
      }
    }
    if (minX === Infinity) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // ---- hover tooltip: who selected this? (avatar + name, shown over another user's selection) ----
  private ensurePeerTip(): HTMLElement {
    if (this.peerTip) return this.peerTip;
    const el = document.createElement("div");
    el.className = "co-peer-tip";
    el.style.cssText =
      "position:absolute;display:none;align-items:center;gap:7px;transform:translate(-50%,calc(-100% - 9px));" +
      "background:#fff;color:#1f2024;padding:5px 11px 5px 6px;border-radius:10px;border:1px solid rgba(16,17,22,0.08);" +
      "font:600 13px/1 system-ui,-apple-system,sans-serif;box-shadow:0 6px 18px rgba(16,17,22,0.18);" +
      "pointer-events:none;z-index:60;white-space:nowrap;";
    const av = document.createElement("span");
    av.className = "av";
    av.style.cssText =
      "width:22px;height:22px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;" +
      "justify-content:center;color:#fff;font:600 11px/1 system-ui;overflow:hidden;background-size:cover;background-position:center;";
    const nm = document.createElement("span");
    nm.className = "nm";
    const tail = document.createElement("span");
    tail.style.cssText =
      "position:absolute;left:50%;bottom:-6px;transform:translateX(-50%);width:0;height:0;" +
      "border-left:6px solid transparent;border-right:6px solid transparent;border-top:6px solid #fff;" +
      "filter:drop-shadow(0 2px 1px rgba(16,17,22,0.12));";
    el.append(av, nm, tail);
    this.opts.container.appendChild(el);
    this.peerTip = el;
    return el;
  }

  /** Update the canvas cursor + the "who selected this" tooltip for the select tool's idle hover. */
  private updateSelectHover(world: { x: number; y: number }): void {
    const self = this.opts.awareness.clientID;
    let hit: { name: string; color: string; photo?: string; top: { x: number; y: number } } | null =
      null;
    this.opts.awareness.getStates().forEach((state, clientId) => {
      if (hit || clientId === self) return;
      const ids = state["selection"] as string[] | undefined;
      if (!ids?.length) return;
      const u = this.peerSelectionUnionRect(ids);
      if (!u) return;
      const pad = this.viewport.screenPx(4);
      if (
        world.x < u.x - pad ||
        world.x > u.x + u.width + pad ||
        world.y < u.y - pad ||
        world.y > u.y + u.height + pad
      )
        return;
      const id = String(state["id"] ?? "");
      const prof = id ? readUserProfile(this.opts.doc, id) : undefined;
      hit = {
        name: String(state["user"] ?? prof?.name ?? "Anonymous"),
        color: String(state["color"] ?? prof?.color ?? "#2563eb"),
        photo: prof?.photo,
        top: { x: u.x + u.width / 2, y: u.y - pad },
      };
    });
    if (hit) {
      this.showPeerTip(hit);
      this.stage.container().style.cursor = CURSOR_URL;
    } else {
      this.hidePeerTip();
      const rc = this.rotationCornerOf(world);
      this.stage.container().style.cursor = rc ? ROTATE_CURSORS[rc] : CURSOR_URL;
    }
  }

  private showPeerTip(hit: {
    name: string;
    color: string;
    photo?: string;
    top: { x: number; y: number };
  }): void {
    const el = this.ensurePeerTip();
    const av = el.querySelector(".av") as HTMLElement;
    if (hit.photo && hit.photo.startsWith("data:")) {
      av.textContent = "";
      av.style.backgroundColor = "";
      av.style.backgroundImage = `url("${hit.photo}")`;
    } else {
      av.style.backgroundImage = "";
      av.style.backgroundColor = hit.color;
      av.textContent = (hit.name.trim()[0] ?? "?").toUpperCase();
    }
    (el.querySelector(".nm") as HTMLElement).textContent = hit.name;
    const screen = this.stage.getAbsoluteTransform().point(hit.top);
    el.style.left = `${screen.x}px`;
    el.style.top = `${screen.y}px`;
    el.style.display = "flex";
  }

  private hidePeerTip(): void {
    if (this.peerTip && this.peerTip.style.display !== "none") this.peerTip.style.display = "none";
  }

  /**
   * Last-writer-wins selection ownership. A node can be the *active* selection of only one
   * peer at a time: when another user selects (or starts dragging) a node I currently have
   * selected, they've taken it over, so I drop it from my selection here. This implements
   * "a newer selection overrides an older one" and fixes the stale transform box that used to
   * linger at a node's old spot while a peer dragged it out from under my selection.
   *
   * Decided without cross-client clocks: an id that *just* entered some peer's selection this
   * tick (absent last tick) was selected after mine, so I yield it; an id a peer is actively
   * dragging is unconditionally theirs. My own in-progress gesture is never disturbed.
   */
  private yieldSelectionToPeers(): void {
    const self = this.opts.awareness.clientID;
    const remoteSel = new Set<string>();
    const dragging = new Set<string>();
    this.opts.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return;
      const ids = state["selection"] as string[] | undefined;
      if (ids) for (const id of ids) remoteSel.add(id);
      // a peer actively dragging OR resizing a node owns it → force-yield it below
      const drag = state["drag"] as { ids?: string[] } | undefined;
      if (drag?.ids) for (const id of drag.ids) dragging.add(id);
      const resize = state["resize"] as { nodes?: { id?: string }[] } | undefined;
      if (resize?.nodes) for (const n of resize.nodes) if (n?.id) dragging.add(n.id);
    });
    // Never disturb an in-progress local gesture — canvas drag/marquee OR a text-layer move/resize.
    const busy =
      !!this.moveState ||
      !!this.marquee ||
      this.textLayer.isMoving() ||
      this.textLayer.isResizing();
    if (!busy) {
      const taken = (id: string): boolean =>
        dragging.has(id) || (remoteSel.has(id) && !this.prevRemoteSel.has(id));
      let changed = false;
      for (const id of [...this.selected]) {
        if (taken(id)) {
          this.selected.delete(id); // a peer took it over → release my transform box
          changed = true;
        }
      }
      // Strokes/connectors/stamps/text/shapes now hold their selection in the text-layer (ADR-0009
      // P3), so yield any of THOSE a peer just took too — else my box lingers (last-writer-wins).
      const textTaken = this.textLayer.selectedIds().filter(taken);
      if (textTaken.length) {
        this.textLayer.deselectIds(textTaken);
        changed = true;
      }
      if (changed) {
        this.reattachTransformer(); // detach the box from the yielded nodes
        this.publishSelection(); // rebroadcast my now-reduced selection (peers + my own awareness)
      }
    }
    this.prevRemoteSel = remoteSel;
  }

  /**
   * Render every *remote* peer's in-progress stroke as an ephemeral preview so drawing streams
   * live (the doc only commits the finished stroke via addStroke). Previews are keyed by the
   * eventual stroke id and dropped the moment the committed node appears (here or in
   * renderObjects/pruneCommittedDraws) or the peer's draw awareness clears (e.g. cancel).
   */
  private renderRemoteDraws(): void {
    const self = this.opts.awareness.clientID;
    const active = new Set<string>();
    this.opts.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return;
      const d = state["draw"] as Partial<DrawState> | undefined;
      if (!d?.id || !d.points?.length) return;
      active.add(d.id);
      if (this.objects.has(d.id)) return; // already committed → the text-layer renders the real svg
      this.remoteDraws.add(d.id);
      this.textLayer.upsertInkDraft(`remote:${d.id}`, {
        id: d.id,
        type: "stroke",
        points: d.points,
        color: d.color ?? "#000000",
        width: d.width ?? 4,
        style: d.style ?? "solid",
        opacity: d.opacity ?? 1,
        authorId: "",
      });
    });
    // drop drafts that committed (the real object now exists) or ended (no longer broadcast)
    for (const id of this.remoteDraws) {
      if (active.has(id) && !this.objects.has(id)) continue;
      this.textLayer.removeInkDraft(`remote:${id}`);
      this.remoteDraws.delete(id);
    }
  }

  // ---- touch: pinch-to-zoom + two-finger pan (mobile) ----
  private bindTouch(): void {
    // Suppress the browser's own menus on the board (long-press context menu on mobile, right-click
    // on desktop) so they don't fight node selection — except inside an active text editor, where
    // the native edit menu (paste etc.) is still wanted.
    this.stage.container().addEventListener("contextmenu", (e) => {
      if (!(e.target as HTMLElement).closest?.(".co-text-editor")) e.preventDefault();
    });
    // On touch, a tap normally generates emulated mouse events (mousedown/up/click) afterwards.
    // With the text/sticky tools that emulated mousedown lands on the canvas and blurs the editor
    // we just opened + focused → it commits instantly (the "menu flicker" + text never sticks on
    // mobile). Cancelling the touch's default action suppresses the emulation; the Konva pointer
    // events (which place + focus the box) still fire, so placement keeps working.
    const placing = (): boolean =>
      this.tool === "text" || this.tool === "sticky" || this.tool === "shapes";
    this.stage.on("touchend", (e) => {
      if (placing()) e.evt.preventDefault();
    });
    this.stage.on("touchstart", (e) => {
      if (placing()) e.evt.preventDefault();
    });
    this.stage.on("touchmove", (e) => {
      const touches = (e.evt as TouchEvent).touches;
      if (!touches || touches.length < 2) return;
      e.evt.preventDefault();
      const a = touches[0];
      const b = touches[1];
      if (!a || !b) return;
      const rect = this.stage.container().getBoundingClientRect();
      const p1 = { x: a.clientX - rect.left, y: a.clientY - rect.top };
      const p2 = { x: b.clientX - rect.left, y: b.clientY - rect.top };
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      this.cancelGestures(); // a 2nd finger turns any draw/marquee/move into a pinch
      if (this.stage.isDragging()) this.stage.stopDrag();
      if (!this.pinch) {
        this.pinch = { dist, cx: center.x, cy: center.y };
        return;
      }
      const oldScale = this.viewport.scale();
      const newScale = this.viewport.clamp(oldScale * (dist / this.pinch.dist));
      // The canvas point under the previous pinch centre is pinned to the new centre,
      // which folds zoom + two-finger pan into one transform.
      const cx = (this.pinch.cx - this.stage.x()) / oldScale;
      const cy = (this.pinch.cy - this.stage.y()) / oldScale;
      this.pinch = { dist, cx: center.x, cy: center.y };
      this.viewport.applyTransform(newScale, {
        x: center.x - cx * newScale,
        y: center.y - cy * newScale,
      });
    });
    const end = (e: Konva.KonvaEventObject<TouchEvent>): void => {
      if (((e.evt as TouchEvent).touches?.length ?? 0) < 2) this.pinch = null;
    };
    this.stage.on("touchend", end);
    this.stage.on("touchcancel", end);
  }

  /** Abort any in-progress single-pointer gesture (used when a pinch begins). */
  private cancelGestures(): void {
    if (this.drawing) {
      this.textLayer.removeInkDraft("local"); // cancelled → drop the DOM preview
      this.drawing = null;
      this.opts.awareness.setLocalStateField("draw", null); // cancelled → stop the live preview
    }
    if (this.marquee) this.cancelMarquee();
    if (this.moveState) {
      for (const id of this.selected) this.nodeById.get(id)?.position({ x: 0, y: 0 });
      this.moveState = null;
      this.opts.awareness.setLocalStateField("drag", null); // cancelled → stop the live preview
      this.content.batchDraw();
    }
    if (this.resizing) {
      this.resizing = false;
      this.opts.awareness.setLocalStateField("resize", null); // cancelled → stop the live preview
    }
    if (this.connectorMove || this.connectorEndDrag || this.drawingConnector) {
      this.connectorMove = null;
      this.connectorEndDrag = null;
      this.drawingConnector?.node.destroy();
      this.drawingConnector = null;
      this.broadcastConnectorEdit(null); // cancelled → stop the live connector preview
      this.renderConnectors(); // restore the committed geometry
    }
  }

  // ---- hand-pan cursor (wheel-zoom + grid tracking live in ViewportController) ----
  private bindDragCursor(): void {
    // Grab → grabbing while the hand tool is actively dragging.
    this.stage.on("dragstart", () => {
      if (this.tool === "hand") this.stage.container().style.cursor = "grabbing";
    });
    this.stage.on("dragend", () => {
      if (this.tool === "hand") this.stage.container().style.cursor = "grab";
    });
  }

  private bindResize(): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.viewport.resize();
      this.syncCursorStage();
    });
    this.resizeObserver.observe(this.opts.container);
  }

  // ---- presence / cursors ----
  private publishCursor(p: { x: number; y: number }): void {
    const now = Date.now();
    if (now - this.lastCursorSent < 1000 / CURSOR_HZ) return;
    this.lastCursorSent = now;
    this.opts.awareness.setLocalStateField("cursor", { x: p.x, y: p.y });
  }

  private bindAwareness(): void {
    this.opts.awareness.on("change", this.onAwarenessChange);
    this.onAwarenessChange();
  }

  private syncCursors(): void {
    const self = this.opts.awareness.clientID;
    const seen = new Set<number>();
    this.opts.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return;
      const cursor = state["cursor"] as { x: number; y: number } | undefined;
      if (!cursor) return;
      seen.add(clientId);
      let group = this.cursors.get(clientId);
      if (!group) {
        group = this.buildCursor(
          String(state["color"] ?? "#2563eb"),
          String(state["user"] ?? "Guest"),
        );
        group.position(cursor);
        group.scale({ x: this.viewport.screenPx(1), y: this.viewport.screenPx(1) });
        this.cursors.set(clientId, group);
        this.cursorLayer.add(group);
      }
      this.cursorTargets.set(clientId, cursor);
    });
    for (const [clientId, group] of this.cursors) {
      if (!seen.has(clientId)) {
        group.destroy();
        this.cursors.delete(clientId);
        this.cursorTargets.delete(clientId);
      }
    }
    this.cursorLayer.batchDraw();
    this.ensureAnim();
  }

  private buildCursor(color: string, name: string): Konva.Group {
    const group = new Konva.Group({ listening: false });
    // Matches the design-mockup cursor: a filled pointer caret with a white edge.
    group.add(
      new Konva.Path({
        data: CURSOR_PATH,
        fill: color,
        stroke: "#fff",
        strokeWidth: 1.5,
        lineJoin: "round",
        shadowColor: "rgba(0,0,0,0.25)",
        shadowBlur: 3,
        shadowOffsetY: 1,
      }),
    );
    const label = new Konva.Label({ x: 16, y: 18 });
    label.add(new Konva.Tag({ fill: color, cornerRadius: 9 }));
    label.add(
      new Konva.Text({ text: name, fill: "#fff", fontSize: 12, padding: 5, fontStyle: "600" }),
    );
    group.add(label);
    return group;
  }

  /** Keep cursors a constant screen size regardless of zoom. */
  private scaleCursors(): void {
    const inv = this.viewport.screenPx(1);
    this.cursors.forEach((g) => g.scale({ x: inv, y: inv }));
  }

  /** Mirror the main camera transform + size onto the cursor stage so its world-space cursors line
   *  up exactly with the board, then redraw. (The cursor stage sits above the HTML text overlay.) */
  private syncCursorStage(): void {
    this.cursorStage.scale({ x: this.stage.scaleX(), y: this.stage.scaleY() });
    this.cursorStage.position(this.stage.position());
    this.cursorStage.size({ width: this.stage.width(), height: this.stage.height() });
    this.cursorLayer.batchDraw();
  }

  /**
   * Glide remote cursors AND remote-dragged/resized objects toward their latest reported targets
   * (same LERP, so a dragged object stays glued under the peer's caret instead of stepping at the
   * 30 Hz awareness rate). The rAF loop runs ONLY while something is actually moving, then stops —
   * no idle cost. Objects' outlines are refreshed in-loop so they track the gliding nodes.
   */
  private ensureAnim(): void {
    if (this.animating) return;
    this.animating = true;
    const step = (): void => {
      let moving = false;
      // remote cursors
      this.cursors.forEach((group, id) => {
        const t = this.cursorTargets.get(id);
        if (!t) return;
        const p = group.position();
        const dx = t.x - p.x;
        const dy = t.y - p.y;
        if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
          group.position(t);
          return;
        }
        group.position({ x: p.x + dx * LERP, y: p.y + dy * LERP });
        moving = true;
      });
      // remote-dragged / resized objects (position + scale)
      this.cursorLayer.batchDraw(); // cursors glided this frame (their own top stage)
      this.overlay.batchDraw();
      if (moving) {
        this.raf = requestAnimationFrame(step);
      } else {
        this.animating = false;
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  destroy(): void {
    this.textLayer.destroy();
    cancelAnimationFrame(this.raf);
    if (this.connGlideRaf) cancelAnimationFrame(this.connGlideRaf);
    this.connectorBar.destroy();
    this.viewport.stopZoomAnim(); // stop any in-flight zoom-step rAF before the stage is gone
    this.opts.awareness.off("change", this.onAwarenessChange);
    window.removeEventListener("blur", this.onWindowBlur);
    window.removeEventListener("pointerup", this.onWindowPointerUp);
    this.resizeObserver?.disconnect();
    this.peerTip?.remove();
    const cursorContainer = this.cursorStage.container();
    this.cursorStage.destroy();
    cursorContainer.remove();
    this.stage.destroy();
  }
}
