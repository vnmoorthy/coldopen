// Shared types for Cold Open. Changing a shape here means updating SPEC.md.

export interface Env {
  HQ: DurableObjectNamespace;
  MEDIA: KVNamespace;
  AI: Ai;
  ASSETS: Fetcher;
  PUBLIC_URL: string;
  PAYMENT_LINK: string;
  CLAUDE_MODEL: string;
  HQ_LAT: string;
  HQ_LON: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  SLACK_WEBHOOK_URL?: string;
  HIGGSFIELD_API_KEY?: string;
  HIGGSFIELD_API_SECRET?: string;
  TASTE_API_KEY?: string;
  BRAINBASE_API_KEY?: string;
}

export type BizStatus =
  | "scouted"
  | "extracting"
  | "building"
  | "critiquing"
  | "directing"
  | "ready"
  | "contacted"
  | "replied"
  | "paid"
  | "removed"
  | "error";

export type AgentName =
  | "Scout"
  | "Archivist"
  | "Builder"
  | "Critic"
  | "Director"
  | "Closer"
  | "CFO"
  | "System";

export interface Brand {
  name: string;
  tagline: string;
  voice: string; // e.g. "warm, neighborly, a little cheeky"
  vibe: string; // e.g. "sunlit Mediterranean street food"
  palette: {
    primary: string; // hex
    secondary: string;
    accent: string;
    background: string;
    text: string;
  };
  fonts: { heading: string; body: string }; // Google Fonts family names
  keywords: string[];
  offerings: { name: string; description: string; price?: string }[];
  offeringsConfirmed: boolean; // true only if taken from the business's own site
  story: string; // 2-3 sentences, factual, no invented history
  sourceSignals: string[]; // what we actually read: "website title", "theme-color #...", "OSM cuisine=..."
}

export type SiteTheme = "editorial" | "bold" | "warm";

export interface SiteSpec {
  version: number;
  theme: SiteTheme;
  headline: string;
  subheadline: string;
  about: string;
  highlights: { title: string; text: string }[]; // exactly 3
  offeringsTitle: string;
  offerings: { name: string; description: string; price?: string }[];
  ctaLabel: string; // e.g. "Order ahead", "Book a table", "Visit us"
  hoursText: string; // from OSM opening_hours if known, else "Hours — owner to confirm"
  seo: { title: string; description: string };
}

export interface ScoreVersion {
  version: number;
  score: number; // 0-100
  notes: string[];
  slopHits: string[]; // banned phrases found deterministically
  provider: string; // "claude-sonnet-5" | "workers-ai:llama-3.3-70b" | "taste-labs"
  at: number;
}

export interface VideoState {
  status: "none" | "rendering" | "ready" | "error";
  url?: string;
  jobId?: string;
  provider?: string; // "higgsfield" | "external"
  error?: string;
}

export interface Business {
  id: string; // slug, unique
  name: string;
  category: string; // "cafe", "restaurant", "bar", "books"...
  lat: number | null;
  lon: number | null;
  address: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  openingHours: string | null;
  osmId: string | null;
  osmTags: Record<string, string>;
  status: BizStatus;
  brand: Brand | null;
  site: SiteSpec | null;
  scores: ScoreVersion[];
  heroImage: string | null; // "/img/<kv-key>"
  video: VideoState;
  pitch: { subject: string; body: string } | null;
  paymentUrl: string | null;
  paymentVerified: boolean;
  paidAt: number | null;
  amountCents: number | null;
  contactedAt: number | null;
  repliedAt: number | null;
  timings: Partial<Record<"scout" | "archivist" | "builder" | "critic" | "director" | "closer" | "total", number>>;
  costCents: number; // estimated model spend for this business
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentEvent {
  id: number;
  ts: number;
  agent: AgentName;
  kind: "info" | "success" | "warn" | "error" | "money";
  text: string;
  bizId?: string;
  data?: Record<string, unknown>;
}

export interface Stats {
  scouted: number; // total non-removed businesses
  built: number; // reached ready or beyond
  tastePassed: number; // final score >= 85
  contacted: number;
  replied: number;
  paid: number;
  revenueCents: number;
  spendCents: number;
  avgBuildMs: number | null;
  bestBuildMs: number | null;
}

export interface Snapshot {
  businesses: Business[];
  events: AgentEvent[]; // most recent 200, oldest first
  stats: Stats;
}

export interface LlmResult<T> {
  data: T;
  provider: string;
  model: string;
  costCents: number;
  ms: number;
}
