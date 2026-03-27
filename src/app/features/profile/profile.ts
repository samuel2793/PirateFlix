import { CommonModule } from '@angular/common';
import { Component, inject, signal, computed, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';

import { FirebaseAuthService } from '../../core/services/firebase-auth';
import { UserDataService, WatchHistoryItem, MyListItem } from '../../core/services/user-data.service';
import { LanguageService } from '../../shared/services/language.service';
import { GlobalNavComponent } from '../../shared/components/global-nav/global-nav';
import { TranslatePipe } from '../../shared/pipes/translate.pipe';
import { TmdbService } from '../../core/services/tmdb';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';

// Genre ID to name mapping (TMDB)
const GENRE_MAP: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
  10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
  10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterModule,
    GlobalNavComponent,
    TranslatePipe,
    MatIconModule,
    MatButtonModule,
    MatDialogModule,
    MatSnackBarModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './profile.html',
  styleUrl: './profile.scss',
})
export class ProfileComponent implements OnDestroy {
  private readonly router = inject(Router);
  private readonly auth = inject(FirebaseAuthService);
  private readonly userData = inject(UserDataService);
  private readonly language = inject(LanguageService);
  private readonly tmdb = inject(TmdbService);
  private readonly snackBar = inject(MatSnackBar);

  @ViewChild('photoInput') photoInput!: ElementRef<HTMLInputElement>;

  // Auth data
  user = this.auth.user;
  isAuthenticated = this.auth.isAuthenticated;
  displayName = computed(() => {
    // Prefer Firestore profile name over Auth name
    const profile = this.userData.profile();
    if (profile?.displayName) return profile.displayName;
    return this.auth.displayName();
  });
  photoUrl = computed(() => {
    // Prefer Firestore profile photo over Auth photo
    const profile = this.userData.profile();
    if (profile?.photoURL) return profile.photoURL;
    return this.auth.photoUrl();
  });

  // User initials for default avatar
  userInitials = computed(() => {
    const name = this.displayName();
    if (!name) return '?';
    
    const words = name.trim().split(/\s+/);
    if (words.length >= 2) {
      return (words[0][0] + words[words.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  });

  // User data from Firestore
  profile = this.userData.profile;
  stats = this.userData.stats;
  watchHistory = this.userData.watchHistory;
  myList = this.userData.myList;
  continueWatching = this.userData.continueWatching;
  loading = this.userData.loading;

  // Computed values
  userEmail = computed(() => this.user()?.email || '');
  
  memberSince = computed(() => {
    const profile = this.profile();
    if (profile?.createdAt) {
      return profile.createdAt.toDate().toLocaleDateString();
    }
    const metadata = this.user()?.metadata;
    if (metadata?.creationTime) {
      return new Date(metadata.creationTime).toLocaleDateString();
    }
    return '';
  });

  totalWatchTime = this.userData.totalWatchTime;
  topGenres = this.userData.topGenres;

  formattedWatchTime = computed(() => {
    const time = this.totalWatchTime();
    if (time.days > 0) return `${time.days}d ${time.hours}h`;
    if (time.hours > 0) return `${time.hours}h ${time.minutes}m`;
    return `${time.minutes}m`;
  });

  // Language
  currentLang = this.language.currentLang;
  isChangingLanguage = this.language.isChangingLanguage;

  // UI State
  activeTab = signal<'overview' | 'history' | 'list'>('overview');
  editingProfile = signal(false);
  editName = signal('');
  showDeleteConfirm = signal(false);
  exportingData = signal(false);
  deletingAccount = signal(false);

  // Helper methods
  getGenreName(genreId: number): string {
    return GENRE_MAP[genreId] || 'Unknown';
  }

  getPosterUrl(path: string | null): string {
    if (!path) return 'assets/placeholders/placeholder_movie.png';
    return this.tmdb.posterUrl(path) || 'assets/placeholders/placeholder_movie.png';
  }

  formatDate(timestamp: any): string {
    if (!timestamp) return '';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  formatEpisodeLabel(item: WatchHistoryItem): string {
    if (item.mediaType !== 'tv') return '';
    const s = String(item.season || 1).padStart(2, '0');
    const e = String(item.episode || 1).padStart(2, '0');
    return `S${s}E${e}`;
  }

  // Tab navigation
  setTab(tab: 'overview' | 'history' | 'list') {
    this.activeTab.set(tab);
  }

  // Profile editing
  startEditProfile() {
    this.editName.set(this.displayName());
    this.editingProfile.set(true);
  }

  cancelEditProfile() {
    this.editingProfile.set(false);
  }

  async saveProfile() {
    const newName = this.editName().trim();
    if (!newName) {
      this.showNotification('Name cannot be empty');
      return;
    }
    if (newName.length > 30) {
      this.showNotification('Name is too long (max 30 characters)');
      return;
    }
    try {
      await this.userData.updateProfile({ displayName: newName });
      this.editingProfile.set(false);
      this.showNotification('Profile updated');
    } catch {
      this.showNotification('Failed to update profile');
    }
  }

  // Photo upload
  openPhotoUpload() {
    this.photoInput?.nativeElement?.click();
  }

  async onPhotoSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      this.showNotification('Please select an image file');
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      this.showNotification('Image must be less than 5MB');
      return;
    }

    try {
      // Convert to base64 data URL for storage
      const dataUrl = await this.fileToDataUrl(file);
      await this.userData.updateProfile({ photoURL: dataUrl });
      this.showNotification('Photo updated');
    } catch {
      this.showNotification('Failed to update photo');
    }
    
    // Clear the input
    input.value = '';
  }

  private fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      
      // Resize image before converting to reduce storage
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxSize = 200; // Max dimension
        let { width, height } = img;
        
        if (width > height && width > maxSize) {
          height = (height * maxSize) / width;
          width = maxSize;
        } else if (height > maxSize) {
          width = (width * maxSize) / height;
          height = maxSize;
        }
        
        canvas.width = width;
        canvas.height = height;
        
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  // Navigation
  navigateToItem(item: WatchHistoryItem | MyListItem) {
    this.router.navigate(['/details', item.mediaType, item.tmdbId]);
  }

  playItem(item: WatchHistoryItem, event: Event) {
    event.stopPropagation();
    const route = ['/play', item.mediaType, item.tmdbId];
    if (item.mediaType === 'tv' && item.season && item.episode) {
      route.push(String(item.season), String(item.episode));
    }
    this.router.navigate(route);
  }

  // History management
  async removeFromHistory(item: WatchHistoryItem, event: Event) {
    event.stopPropagation();
    try {
      await this.userData.removeFromHistory(item.id);
      this.showNotification('Removed from history');
    } catch {
      this.showNotification('Failed to remove item');
    }
  }

  async clearAllHistory() {
    try {
      await this.userData.clearWatchHistory();
      this.showNotification('History cleared');
    } catch {
      this.showNotification('Failed to clear history');
    }
  }

  // My List management
  async removeFromList(item: MyListItem, event: Event) {
    event.stopPropagation();
    try {
      await this.userData.removeFromMyList(item.id);
      this.showNotification('Removed from list');
    } catch {
      this.showNotification('Failed to remove item');
    }
  }

  // Data management
  async exportData() {
    this.exportingData.set(true);
    try {
      const data = await this.userData.exportUserData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pirateflix-data-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.showNotification('Data exported');
    } catch {
      this.showNotification('Failed to export data');
    } finally {
      this.exportingData.set(false);
    }
  }

  // Account deletion
  showDeleteAccountConfirm() {
    this.showDeleteConfirm.set(true);
  }

  cancelDeleteAccount() {
    this.showDeleteConfirm.set(false);
  }

  async confirmDeleteAccount() {
    this.deletingAccount.set(true);
    try {
      await this.userData.deleteAllUserData();
      await this.auth.signOut();
      this.router.navigate(['/']);
      this.showNotification('Account data deleted');
    } catch {
      this.showNotification('Failed to delete account data');
    } finally {
      this.deletingAccount.set(false);
      this.showDeleteConfirm.set(false);
    }
  }

  logout() {
    void this.auth.signOut();
    this.router.navigate(['/']);
  }

  private showNotification(message: string) {
    this.snackBar.open(message, 'OK', {
      duration: 3000,
      horizontalPosition: 'center',
      verticalPosition: 'bottom',
    });
  }

  goBack() {
    this.router.navigate(['/']);
  }

  goToSettings() {
    this.router.navigate(['/settings']);
  }

  ngOnDestroy() {
    this.userData.destroy();
  }
}
