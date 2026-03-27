import { Injectable, inject, signal, computed, effect } from '@angular/core';
import { 
  getFirestore, 
  Firestore, 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  deleteDoc,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  Timestamp,
  writeBatch,
  increment,
  Unsubscribe
} from 'firebase/firestore';
import { FirebaseAuthService } from './firebase-auth';

// Types
export interface UserProfile {
  displayName: string;
  photoURL: string | null;
  createdAt: Timestamp;
  lastActiveAt: Timestamp;
}

export interface UserStats {
  moviesWatched: number;
  episodesWatched: number;
  totalWatchTimeMinutes: number;
  favoriteGenres: Record<string, number>;
  currentStreak: number;
  lastWatchDate: string | null;
}

export interface WatchHistoryItem {
  id: string;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  poster: string | null;
  backdrop: string | null;
  progress: number; // 0-100
  lastPosition: number; // seconds
  season?: number;
  episode?: number;
  episodeTitle?: string;
  runtime?: number; // minutes
  watchedAt: Timestamp;
  genres?: number[];
}

export interface MyListItem {
  id: string;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
  poster: string | null;
  backdrop: string | null;
  year?: string;
  rating?: number;
  addedAt: Timestamp;
}

@Injectable({ providedIn: 'root' })
export class UserDataService {
  private readonly auth = inject(FirebaseAuthService);
  private db: Firestore | null = null;
  private unsubscribers: Unsubscribe[] = [];
  private lastUserId: string | null = null;

  // State signals
  profile = signal<UserProfile | null>(null);
  stats = signal<UserStats>({
    moviesWatched: 0,
    episodesWatched: 0,
    totalWatchTimeMinutes: 0,
    favoriteGenres: {},
    currentStreak: 0,
    lastWatchDate: null,
  });
  watchHistory = signal<WatchHistoryItem[]>([]);
  myList = signal<MyListItem[]>([]);
  loading = signal(true);
  error = signal<string | null>(null);

  // Computed
  continueWatching = computed(() => {
    return this.watchHistory()
      .filter(item => item.progress > 0 && item.progress < 95)
      .slice(0, 10);
  });

  recentlyWatched = computed(() => {
    return this.watchHistory()
      .filter(item => item.progress >= 95)
      .slice(0, 20);
  });

  topGenres = computed(() => {
    const genres = this.stats().favoriteGenres;
    return Object.entries(genres)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([genreId, count]) => ({ genreId: Number(genreId), count }));
  });

  totalWatchTime = computed(() => {
    const minutes = this.stats().totalWatchTimeMinutes;
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
      const remainingHours = hours % 24;
      return { days, hours: remainingHours, minutes: minutes % 60 };
    }
    return { days: 0, hours, minutes: minutes % 60 };
  });

  constructor() {
    // Use effect to react to auth state changes
    effect(() => {
      const user = this.auth.user();
      const isReady = this.auth.ready();
      
      if (!isReady) return;
      
      const userId = user?.uid || null;
      
      // Only re-initialize if user changed
      if (userId !== this.lastUserId) {
        this.lastUserId = userId;
        
        if (userId) {
          // User logged in, load their data
          this.initializeForUser();
        } else {
          // User logged out, clear data
          this.clearUserData();
        }
      }
    });
  }

  private clearUserData() {
    // Cleanup subscriptions
    this.unsubscribers.forEach(unsub => unsub());
    this.unsubscribers = [];
    
    // Reset state
    this.profile.set(null);
    this.stats.set({
      moviesWatched: 0,
      episodesWatched: 0,
      totalWatchTimeMinutes: 0,
      favoriteGenres: {},
      currentStreak: 0,
      lastWatchDate: null,
    });
    this.watchHistory.set([]);
    this.myList.set([]);
    this.loading.set(false);
    this.error.set(null);
  }

  private async initializeForUser() {
    const user = this.auth.user();
    if (!user) {
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.error.set(null);

    try {
      // Get Firestore instance from the same app
      const { getApp } = await import('firebase/app');
      const app = getApp();
      this.db = getFirestore(app);

      // Load all user data
      await Promise.all([
        this.loadProfile(),
        this.loadStats(),
        this.loadWatchHistory(),
        this.loadMyList(),
      ]);

      // Subscribe to real-time updates
      this.subscribeToUpdates();

      // Update last active
      this.updateLastActive();
    } catch (err) {
      console.error('Failed to initialize user data:', err);
      this.error.set('Failed to load user data');
    } finally {
      this.loading.set(false);
    }
  }

  // === Profile ===
  private async loadProfile() {
    const user = this.auth.user();
    if (!this.db || !user) return;

    const profileRef = doc(this.db, 'users', user.uid, 'data', 'profile');
    const profileSnap = await getDoc(profileRef);

    if (profileSnap.exists()) {
      this.profile.set(profileSnap.data() as UserProfile);
    } else {
      // Create initial profile
      const newProfile: UserProfile = {
        displayName: user.displayName || user.email || 'User',
        photoURL: user.photoURL,
        createdAt: Timestamp.now(),
        lastActiveAt: Timestamp.now(),
      };
      await setDoc(profileRef, newProfile);
      this.profile.set(newProfile);
    }
  }

  async updateProfile(data: Partial<Pick<UserProfile, 'displayName' | 'photoURL'>>) {
    const user = this.auth.user();
    if (!this.db || !user) throw new Error('Not authenticated');

    const profileRef = doc(this.db, 'users', user.uid, 'data', 'profile');
    
    // Use setDoc with merge to create the document if it doesn't exist
    await setDoc(profileRef, {
      ...data,
      lastActiveAt: Timestamp.now(),
    }, { merge: true });
    
    this.profile.update(p => p ? { ...p, ...data } : {
      displayName: data.displayName || user.displayName || 'User',
      photoURL: data.photoURL || null,
      createdAt: Timestamp.now(),
      lastActiveAt: Timestamp.now(),
    });
  }

  private async updateLastActive() {
    const user = this.auth.user();
    if (!this.db || !user) return;

    const profileRef = doc(this.db, 'users', user.uid, 'data', 'profile');
    // Use setDoc with merge to avoid errors if document doesn't exist
    await setDoc(profileRef, { lastActiveAt: Timestamp.now() }, { merge: true });
  }

  // === Stats ===
  private async loadStats() {
    const user = this.auth.user();
    if (!this.db || !user) return;

    const statsRef = doc(this.db, 'users', user.uid, 'data', 'stats');
    const statsSnap = await getDoc(statsRef);

    if (statsSnap.exists()) {
      this.stats.set(statsSnap.data() as UserStats);
    } else {
      // Create initial stats
      const newStats: UserStats = {
        moviesWatched: 0,
        episodesWatched: 0,
        totalWatchTimeMinutes: 0,
        favoriteGenres: {},
        currentStreak: 0,
        lastWatchDate: null,
      };
      await setDoc(statsRef, newStats);
    }
  }

  // === Watch History ===
  private async loadWatchHistory() {
    const user = this.auth.user();
    if (!this.db || !user) return;

    const historyRef = collection(this.db, 'users', user.uid, 'watchHistory');
    const q = query(historyRef, orderBy('watchedAt', 'desc'), limit(50));
    const snapshot = await getDocs(q);

    const items: WatchHistoryItem[] = [];
    snapshot.forEach(doc => {
      items.push({ id: doc.id, ...doc.data() } as WatchHistoryItem);
    });
    this.watchHistory.set(items);
  }

  async updateWatchProgress(item: Omit<WatchHistoryItem, 'id' | 'watchedAt'>) {
    const user = this.auth.user();
    if (!this.db || !user) {
      console.warn('⚠️ Cannot save watch progress: db or user not available', { db: !!this.db, user: !!user });
      return;
    }
    
    console.log('💾 Saving watch progress:', {
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      title: item.title,
      progress: item.progress,
      season: item.season,
      episode: item.episode
    });

    const itemId = item.mediaType === 'tv' 
      ? `${item.mediaType}_${item.tmdbId}_s${item.season}_e${item.episode}`
      : `${item.mediaType}_${item.tmdbId}`;

    const historyRef = doc(this.db, 'users', user.uid, 'watchHistory', itemId);
    const statsRef = doc(this.db, 'users', user.uid, 'data', 'stats');

    const existingDoc = await getDoc(historyRef);
    const wasCompleted = existingDoc.exists() && (existingDoc.data() as WatchHistoryItem).progress >= 95;
    const isNowCompleted = item.progress >= 95;

    const batch = writeBatch(this.db);

    // Update watch history
    batch.set(historyRef, {
      ...item,
      watchedAt: Timestamp.now(),
    }, { merge: true });

    // Update stats if newly completed
    if (!wasCompleted && isNowCompleted) {
      const today = new Date().toISOString().split('T')[0];
      const currentStats = this.stats();
      
      // Check streak
      let newStreak = 1;
      if (currentStats.lastWatchDate) {
        const lastDate = new Date(currentStats.lastWatchDate);
        const todayDate = new Date(today);
        const diffDays = Math.floor((todayDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
        
        if (diffDays === 0) {
          newStreak = currentStats.currentStreak;
        } else if (diffDays === 1) {
          newStreak = currentStats.currentStreak + 1;
        }
      }

      const statsUpdate: Record<string, any> = {
        lastWatchDate: today,
        currentStreak: newStreak,
        totalWatchTimeMinutes: increment(item.runtime || 0),
      };

      if (item.mediaType === 'movie') {
        statsUpdate['moviesWatched'] = increment(1);
      } else {
        statsUpdate['episodesWatched'] = increment(1);
      }

      // Update genre counts
      if (item.genres?.length) {
        for (const genreId of item.genres) {
          statsUpdate[`favoriteGenres.${genreId}`] = increment(1);
        }
      }

      // Use batch.set with merge to avoid errors if document doesn't exist
      batch.set(statsRef, statsUpdate, { merge: true });
    }

    await batch.commit();

    // Refresh local data
    await this.loadWatchHistory();
    await this.loadStats();
  }

  async removeFromHistory(itemId: string) {
    const user = this.auth.user();
    if (!this.db || !user) return;

    await deleteDoc(doc(this.db, 'users', user.uid, 'watchHistory', itemId));
    this.watchHistory.update(items => items.filter(i => i.id !== itemId));
  }

  async clearWatchHistory() {
    const user = this.auth.user();
    if (!this.db || !user) return;

    const historyRef = collection(this.db, 'users', user.uid, 'watchHistory');
    const snapshot = await getDocs(historyRef);
    
    const batch = writeBatch(this.db);
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    this.watchHistory.set([]);
  }

  // === My List ===
  private async loadMyList() {
    const user = this.auth.user();
    if (!this.db || !user) return;

    const listRef = collection(this.db, 'users', user.uid, 'myList');
    const q = query(listRef, orderBy('addedAt', 'desc'));
    const snapshot = await getDocs(q);

    const items: MyListItem[] = [];
    snapshot.forEach(doc => {
      items.push({ id: doc.id, ...doc.data() } as MyListItem);
    });
    this.myList.set(items);
  }

  async addToMyList(item: Omit<MyListItem, 'id' | 'addedAt'>) {
    const user = this.auth.user();
    if (!this.db || !user) return;

    const itemId = `${item.mediaType}_${item.tmdbId}`;
    const listRef = doc(this.db, 'users', user.uid, 'myList', itemId);

    await setDoc(listRef, {
      ...item,
      addedAt: Timestamp.now(),
    });

    this.myList.update(items => [{
      ...item,
      id: itemId,
      addedAt: Timestamp.now(),
    }, ...items]);
  }

  async removeFromMyList(itemId: string) {
    const user = this.auth.user();
    if (!this.db || !user) return;

    await deleteDoc(doc(this.db, 'users', user.uid, 'myList', itemId));
    this.myList.update(items => items.filter(i => i.id !== itemId));
  }

  isInMyList(mediaType: 'movie' | 'tv', tmdbId: number): boolean {
    const itemId = `${mediaType}_${tmdbId}`;
    return this.myList().some(item => item.id === itemId);
  }

  // === Real-time subscriptions ===
  private subscribeToUpdates() {
    const user = this.auth.user();
    if (!this.db || !user) return;

    // Subscribe to stats updates
    const statsRef = doc(this.db, 'users', user.uid, 'data', 'stats');
    const unsubStats = onSnapshot(statsRef, (doc) => {
      if (doc.exists()) {
        this.stats.set(doc.data() as UserStats);
      }
    });
    this.unsubscribers.push(unsubStats);
  }

  // === Data Export ===
  async exportUserData(): Promise<object> {
    return {
      profile: this.profile(),
      stats: this.stats(),
      watchHistory: this.watchHistory(),
      myList: this.myList(),
      exportedAt: new Date().toISOString(),
    };
  }

  // === Account Deletion ===
  async deleteAllUserData() {
    const user = this.auth.user();
    if (!this.db || !user) return;

    // Delete all subcollections
    const collections = ['watchHistory', 'myList'];
    for (const collName of collections) {
      const collRef = collection(this.db, 'users', user.uid, collName);
      const snapshot = await getDocs(collRef);
      const batch = writeBatch(this.db);
      snapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }

    // Delete data documents
    const dataRef = collection(this.db, 'users', user.uid, 'data');
    const dataSnapshot = await getDocs(dataRef);
    const batch = writeBatch(this.db);
    dataSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    // Reset local state
    this.profile.set(null);
    this.stats.set({
      moviesWatched: 0,
      episodesWatched: 0,
      totalWatchTimeMinutes: 0,
      favoriteGenres: {},
      currentStreak: 0,
      lastWatchDate: null,
    });
    this.watchHistory.set([]);
    this.myList.set([]);
  }

  // Cleanup
  destroy() {
    this.unsubscribers.forEach(unsub => unsub());
    this.unsubscribers = [];
  }
}
