import { Injectable, computed, signal } from '@angular/core';
import { initializeApp, FirebaseApp } from 'firebase/app';
import {
  Auth,
  GoogleAuthProvider,
  User,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth';

import { APP_CONFIG } from '../config/app-config-public';
import { FIREBASE_CONFIG } from '../config/app-config-private';

type FirebaseWebConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  measurementId?: string;
};

@Injectable({ providedIn: 'root' })
export class FirebaseAuthService {
  private app: FirebaseApp | null = null;
  private auth: Auth | null = null;

  user = signal<User | null>(null);
  ready = signal(false);
  available = signal(false);
  error = signal<string | null>(null);

  displayName = computed(() => {
    const current = this.user();
    return current?.displayName || current?.email || 'User';
  });

  photoUrl = computed(() => {
    return this.user()?.photoURL || null;
  });

  isAuthenticated = computed(() => !!this.user());

  constructor() {
    if (!APP_CONFIG.firebase.enabled) {
      this.ready.set(true);
      return;
    }

    const config = FIREBASE_CONFIG as FirebaseWebConfig | undefined;
    if (!this.isConfigValid(config)) {
      this.error.set('Firebase config missing.');
      this.ready.set(true);
      return;
    }

    try {
      this.app = initializeApp(config);
      this.auth = getAuth(this.app);
      this.available.set(true);
      onAuthStateChanged(this.auth, (user: User | null) => {
        this.user.set(user);
        this.ready.set(true);
      });
    } catch (err) {
      this.error.set('Failed to initialize Firebase auth.');
      this.ready.set(true);
      console.error(err);
    }
  }

  async signInWithGoogle(): Promise<void> {
    if (!this.auth) {
      this.error.set('Firebase auth not configured.');
      return;
    }

    this.error.set(null);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(this.auth, provider);
    } catch (err) {
      this.error.set('Google sign-in failed.');
      console.error(err);
    }
  }

  async signInWithEmail(email: string, password: string): Promise<void> {
    if (!this.auth) {
      this.error.set('Firebase auth not configured.');
      return;
    }

    this.error.set(null);
    try {
      await signInWithEmailAndPassword(this.auth, email, password);
    } catch (err) {
      this.error.set('Email sign-in failed.');
      console.error(err);
    }
  }

  async signOut(): Promise<void> {
    if (!this.auth) return;
    try {
      await signOut(this.auth);
    } catch (err) {
      this.error.set('Sign-out failed.');
      console.error(err);
    }
  }

  private isConfigValid(config?: FirebaseWebConfig): config is FirebaseWebConfig {
    return !!(
      config?.apiKey &&
      config?.authDomain &&
      config?.projectId &&
      config?.appId
    );
  }
}
