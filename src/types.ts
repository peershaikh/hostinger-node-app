export interface SearchPayload {
  source: string;
  destination: string;
  date?: string;
  classType?: string;
  quota?: string;
  isAISuggestion?: boolean;
}

export interface Train {
  number: string;
  name?: string;
  departure?: string;
  arrival?: string;
  dayNumber?: number;
  duration_mins?: number;
  total_journey_time?: string;
  type?: string;
  fromStationCode?: string;
  toStationCode?: string;
  availability?: any;
  classes?: any[];
  _rawCategory?: string;
  _isLive?: boolean;
}

export interface Leg extends Train {
  trainNo: string;
  trainName: string;
  availability?: {
    status: string;
    wlCount: number;
  };
  confirmation_probability?: number;
  confidence_badge?: string;
}

export interface SplitJourney {
  hub: string;
  leg1: Leg;
  leg2: Leg;
  bufferMinutes: number;
  totalDuration: number;
  score: number;
  badges: string[];
  travelDate: string;
  rollover: boolean;
  ai_strategy?: string;
  ai_insight?: string;
  recommendation_insight?: string;
  confirmation_probability?: number;
  confidence_badge?: string;
  delayRisk?: string;
  legs?: Leg[];
  isSameTrain?: boolean;
}

export interface LiveTrainStatus {
  current_station: string;
  latitude?: number;
  longitude?: number;
  delay_minutes: number;
  status_summary: string;
  last_updated: string;
  next_station?: string;
  is_running?: boolean;
}

export interface CombinedSearchResponse {
  direct: any[];
  split: SplitJourney[];
  split_recommended: boolean;
  message: string;
  data_source?: string;
  warning?: string;
}