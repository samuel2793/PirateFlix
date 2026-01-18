import { Component, signal, OnInit, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-intro',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './intro.html',
  styleUrls: ['./intro.scss'],
})
export class IntroComponent implements OnInit {
  @Output() introComplete = new EventEmitter<void>();

  phase = signal<'loading' | 'reveal' | 'fadeout' | 'done'>('loading');
  showIntro = signal(true);

  private readonly INTRO_KEY = 'pirateflix_intro_seen';
  private readonly INTRO_DURATION = 2000; // Quick and impactful

  ngOnInit() {
    // Check if intro was already shown
    if (this.hasSeenIntro()) {
      this.skipIntro();
      return;
    }

    // Start animation sequence
    this.startAnimationSequence();
  }

  private hasSeenIntro(): boolean {
    try {
      return localStorage.getItem(this.INTRO_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private markIntroAsSeen(): void {
    try {
      localStorage.setItem(this.INTRO_KEY, 'true');
    } catch {}
  }

  private startAnimationSequence(): void {
    // Brief loading moment, then reveal
    setTimeout(() => {
      this.phase.set('reveal');
    }, 200);

    // Start fade out
    setTimeout(() => {
      this.phase.set('fadeout');
    }, 1500);

    // Complete
    setTimeout(() => {
      this.completeIntro();
    }, this.INTRO_DURATION);
  }

  skipIntro(): void {
    this.showIntro.set(false);
    this.phase.set('done');
    this.introComplete.emit();
  }

  private completeIntro(): void {
    this.markIntroAsSeen();
    this.showIntro.set(false);
    this.phase.set('done');
    this.introComplete.emit();
  }
}
