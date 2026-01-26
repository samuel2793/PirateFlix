import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { TmdbService } from './tmdb';

/**
 * Result from credits detection
 */
export interface CreditsInfo {
  /** Time in seconds when credits start (from video start) */
  creditsStartTime: number;
  /** Source of the data */
  source: 'external-api' | 'tmdb-runtime' | 'heuristic';
  /** Confidence level (0-1) */
  confidence: number;
}

/**
 * Cache entry for credits data
 */
interface CreditsCacheEntry {
  showId: number;
  season: number;
  episode: number;
  data: CreditsInfo | null;
  timestamp: number;
}

/**
 * Service to detect when credits start in TV episodes.
 * 
 * Uses multiple sources in priority order:
 * 1. External API (if available) - most accurate
 * 2. TMDB runtime comparison - good accuracy
 * 3. Heuristic based on episode duration - fallback
 */
@Injectable({ providedIn: 'root' })
export class CreditsDetectionService {
  private readonly http = inject(HttpClient);
  private readonly tmdb = inject(TmdbService);
  
  // Cache to avoid repeated API calls
  private readonly cache = new Map<string, CreditsCacheEntry>();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  
  // TheIntroDB API configuration (uses local proxy to avoid CORS)
  private readonly EXTERNAL_API_ENABLED = true;

  /**
   * Generate cache key for an episode
   */
  private getCacheKey(showId: number, season: number, episode: number): string {
    return `${showId}_s${season}_e${episode}`;
  }

  /**
   * Get credits info from cache if valid
   */
  private getFromCache(showId: number, season: number, episode: number): CreditsInfo | null {
    const key = this.getCacheKey(showId, season, episode);
    const entry = this.cache.get(key);
    
    if (entry && Date.now() - entry.timestamp < this.CACHE_TTL_MS) {
      return entry.data;
    }
    
    return null;
  }

  /**
   * Save credits info to cache
   */
  private saveToCache(showId: number, season: number, episode: number, data: CreditsInfo | null): void {
    const key = this.getCacheKey(showId, season, episode);
    this.cache.set(key, {
      showId,
      season,
      episode,
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Try to get credits time from TheIntroDB API via local proxy
   * TheIntroDB API: https://theintrodb.org/docs
   * Returns credits start time in milliseconds (start_ms)
   */
  private async tryExternalApi(
    showId: number, 
    season: number, 
    episode: number
  ): Promise<CreditsInfo | null> {
    if (!this.EXTERNAL_API_ENABLED) {
      return null;
    }

    try {
      // Use local proxy endpoint to avoid CORS issues
      // Endpoint: GET /api/theintrodb/media?tmdb_id=X&season=Y&episode=Z
      const params = new URLSearchParams();
      params.set('tmdb_id', showId.toString());
      params.set('season', season.toString());
      params.set('episode', episode.toString());
      
      const response = await firstValueFrom(
        this.http.get<any>(`/api/theintrodb/media?${params.toString()}`)
      );

      // TheIntroDB returns: { credits: { start_ms: number, end_ms: number|null, confidence: number } }
      if (response?.credits?.start_ms != null) {
        const creditsStartSeconds = response.credits.start_ms / 1000;
        const confidence = response.credits.confidence ?? 0.5;
        
        console.log(`[CreditsDetection] Found TheIntroDB credits data: ${creditsStartSeconds}s (confidence: ${confidence})`);
        return {
          creditsStartTime: creditsStartSeconds,
          source: 'external-api',
          confidence: confidence,
        };
      }
      
      console.log('[CreditsDetection] TheIntroDB has no credits data for this episode');
    } catch (err: any) {
      // Only log if it's not a 404 (show not in database)
      if (err?.status !== 404) {
        console.warn('[CreditsDetection] TheIntroDB proxy error:', err?.message || err);
      }
    }

    return null;
  }

  /**
   * Get episode runtime from TMDB
   * TMDB runtime represents the content duration (without credits typically)
   */
  private async getTmdbRuntime(
    showId: number,
    season: number,
    episode: number
  ): Promise<number | null> {
    try {
      const seasonData = await firstValueFrom(this.tmdb.tvSeason(showId, season));
      const episodes = seasonData?.episodes || [];
      const ep = episodes.find((e: any) => e.episode_number === episode);
      
      if (ep?.runtime && ep.runtime > 0) {
        return ep.runtime; // in minutes
      }
    } catch (err) {
      console.warn('Could not fetch TMDB runtime:', err);
    }
    
    return null;
  }

  /**
   * Calculate credits start time using TMDB runtime
   * 
   * Logic:
   * - TMDB runtime is the "content" duration (usually without end credits)
   * - We add a small buffer for safety
   */
  private calculateFromTmdbRuntime(
    tmdbRuntimeMinutes: number,
    videoDurationSeconds: number
  ): CreditsInfo | null {
    const tmdbRuntimeSeconds = tmdbRuntimeMinutes * 60;
    
    // If video is significantly longer than TMDB runtime, credits = difference
    if (videoDurationSeconds > tmdbRuntimeSeconds + 30) {
      // TMDB runtime IS the credits start time (approximately)
      // Add a 10-second buffer before to be safe
      const creditsStart = Math.max(0, tmdbRuntimeSeconds - 10);
      
      console.log(`📺 TMDB runtime: ${tmdbRuntimeMinutes}min, video: ${(videoDurationSeconds/60).toFixed(1)}min`);
      console.log(`📺 Credits start calculated at: ${this.formatTime(creditsStart)}`);
      
      return {
        creditsStartTime: creditsStart,
        source: 'tmdb-runtime',
        confidence: 0.75,
      };
    }
    
    // If durations are similar, TMDB runtime might include credits
    // Use a percentage-based approach instead
    return null;
  }

  /**
   * Calculate credits start using heuristics based on episode duration
   * 
   * Research-based estimates:
   * - Short episodes (<25 min): ~45-60 seconds of credits
   * - Standard episodes (25-45 min): ~60-90 seconds of credits
   * - Long episodes (45-60 min): ~90-120 seconds of credits
   * - Very long episodes (>60 min): ~120-180 seconds of credits
   */
  private calculateFromHeuristics(videoDurationSeconds: number): CreditsInfo {
    const durationMinutes = videoDurationSeconds / 60;
    let estimatedCreditsSeconds: number;
    let confidence: number;

    if (durationMinutes < 15) {
      // Very short content (web series, shorts)
      estimatedCreditsSeconds = 30;
      confidence = 0.4;
    } else if (durationMinutes < 25) {
      // Short episodes (sitcoms, animations)
      estimatedCreditsSeconds = 45;
      confidence = 0.5;
    } else if (durationMinutes < 35) {
      // Standard half-hour slots
      estimatedCreditsSeconds = 60;
      confidence = 0.55;
    } else if (durationMinutes < 50) {
      // Standard hour-long episodes
      estimatedCreditsSeconds = 90;
      confidence = 0.6;
    } else if (durationMinutes < 70) {
      // Extended episodes
      estimatedCreditsSeconds = 120;
      confidence = 0.55;
    } else {
      // Very long episodes / mini-movies
      estimatedCreditsSeconds = 150;
      confidence = 0.5;
    }

    const creditsStart = videoDurationSeconds - estimatedCreditsSeconds;
    
    console.log(`📊 Heuristic credits estimate: ${estimatedCreditsSeconds}s before end`);

    return {
      creditsStartTime: Math.max(videoDurationSeconds * 0.85, creditsStart),
      source: 'heuristic',
      confidence,
    };
  }

  /**
   * Get the credits start time for an episode
   * 
   * @param showId TMDB show ID
   * @param season Season number
   * @param episode Episode number  
   * @param videoDurationSeconds Actual video duration in seconds
   * @returns Credits info or null if detection fails
   */
  async getCreditsStartTime(
    showId: number,
    season: number,
    episode: number,
    videoDurationSeconds: number
  ): Promise<CreditsInfo> {
    // Check cache first
    const cached = this.getFromCache(showId, season, episode);
    if (cached) {
      // Adjust cached time if video duration is significantly different
      // This handles cases where different video files have different lengths
      if (cached.source === 'tmdb-runtime' || cached.source === 'external-api') {
        return cached;
      }
    }

    // Try external API first (most accurate)
    const externalResult = await this.tryExternalApi(showId, season, episode);
    if (externalResult) {
      this.saveToCache(showId, season, episode, externalResult);
      return externalResult;
    }

    // Try TMDB runtime comparison
    const tmdbRuntime = await this.getTmdbRuntime(showId, season, episode);
    if (tmdbRuntime) {
      const tmdbResult = this.calculateFromTmdbRuntime(tmdbRuntime, videoDurationSeconds);
      if (tmdbResult) {
        this.saveToCache(showId, season, episode, tmdbResult);
        return tmdbResult;
      }
    }

    // Fallback to heuristics
    const heuristicResult = this.calculateFromHeuristics(videoDurationSeconds);
    // Don't cache heuristic results as they depend on video duration
    return heuristicResult;
  }

  /**
   * Calculate how many seconds before the end of the video to trigger the next episode overlay
   */
  async getTriggerSecondsBeforeEnd(
    showId: number,
    season: number,
    episode: number,
    videoDurationSeconds: number
  ): Promise<{ seconds: number; source: string }> {
    const creditsInfo = await this.getCreditsStartTime(
      showId,
      season,
      episode,
      videoDurationSeconds
    );

    const secondsBeforeEnd = videoDurationSeconds - creditsInfo.creditsStartTime;
    
    // Add countdown time to trigger point (so user sees overlay during credits)
    // Minimum 30 seconds, maximum 180 seconds before end
    const triggerSeconds = Math.max(30, Math.min(180, secondsBeforeEnd));

    console.log(`🎬 Trigger point: ${triggerSeconds.toFixed(0)}s before end (source: ${creditsInfo.source})`);

    return {
      seconds: triggerSeconds,
      source: creditsInfo.source,
    };
  }

  /**
   * Format seconds to MM:SS or HH:MM:SS
   */
  private formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.clear();
  }
}
