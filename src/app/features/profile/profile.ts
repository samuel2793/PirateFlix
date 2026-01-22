import { CommonModule } from '@angular/common';
import { Component, inject, signal, computed } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';

import { FirebaseAuthService } from '../../core/services/firebase-auth';
import { LanguageService, SupportedLang } from '../../shared/services/language.service';
import { GlobalNavComponent } from '../../shared/components/global-nav/global-nav';

import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    GlobalNavComponent,
    MatIconModule,
    MatButtonModule,
    MatDialogModule,
    MatSnackBarModule,
  ],
  templateUrl: './profile.html',
  styleUrl: './profile.scss',
})
export class ProfileComponent {
  private readonly router = inject(Router);
  private readonly auth = inject(FirebaseAuthService);
  private readonly language = inject(LanguageService);
  private readonly snackBar = inject(MatSnackBar);

  // User data
  user = this.auth.user;
  isAuthenticated = this.auth.isAuthenticated;
  displayName = this.auth.displayName;
  photoUrl = this.auth.photoUrl;

  userEmail = computed(() => this.user()?.email || '');
  userCreatedAt = computed(() => {
    const metadata = this.user()?.metadata;
    if (metadata?.creationTime) {
      return new Date(metadata.creationTime).toLocaleDateString();
    }
    return '';
  });

  // Language
  currentLang = this.language.currentLang;
  isChangingLanguage = this.language.isChangingLanguage;

  // UI State
  activeSection = signal<'overview' | 'activity' | 'security' | 'data'>('overview');
  editingProfile = signal(false);
  editName = signal('');
  
  // Mock data for activity (would come from a service in production)
  watchHistory = signal([
    { id: 1, title: 'Breaking Bad', type: 'tv', episode: 'S5E16', progress: 100, date: '2 hours ago', poster: '' },
    { id: 2, title: 'The Matrix', type: 'movie', progress: 75, date: 'Yesterday', poster: '' },
    { id: 3, title: 'Stranger Things', type: 'tv', episode: 'S4E9', progress: 45, date: '3 days ago', poster: '' },
  ]);

  myList = signal([
    { id: 1, title: 'Inception', type: 'movie', poster: '' },
    { id: 2, title: 'The Office', type: 'tv', poster: '' },
    { id: 3, title: 'Interstellar', type: 'movie', poster: '' },
  ]);

  activeSessions = signal([
    { device: 'Windows PC', browser: 'Chrome', location: 'Madrid, Spain', current: true, lastActive: 'Now' },
    { device: 'iPhone 15', browser: 'Safari', location: 'Madrid, Spain', current: false, lastActive: '2 hours ago' },
  ]);

  // Section navigation
  setSection(section: 'overview' | 'activity' | 'security' | 'data') {
    this.activeSection.set(section);
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
    // Would call auth service to update profile
    this.editingProfile.set(false);
    this.showNotification('Profile updated successfully');
  }

  // Language
  changeLang(lang: SupportedLang) {
    this.language.setLang(lang);
  }

  // Security actions
  async changePassword() {
    // Would trigger password reset email
    this.showNotification('Password reset email sent');
  }

  async logoutAllDevices() {
    // Would invalidate all sessions
    this.showNotification('Logged out from all devices');
  }

  async logoutSession(session: any) {
    const sessions = this.activeSessions().filter(s => s !== session);
    this.activeSessions.set(sessions);
    this.showNotification('Session ended');
  }

  // Data actions
  async downloadData() {
    this.showNotification('Preparing your data download...');
  }

  async deleteAccount() {
    // Would show confirmation dialog
    this.showNotification('Account deletion requires confirmation via email');
  }

  // Utility
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
}
