import {
  trigger,
  transition,
  style,
  query,
  animate,
  group,
} from '@angular/animations';

// Fade transition for all routes
export const fadeAnimation = trigger('routeAnimations', [
  transition('* <=> *', [
    // Set initial state
    query(':enter, :leave', [
      style({
        position: 'absolute',
        width: '100%',
        opacity: 0,
      }),
    ], { optional: true }),
    
    // Animate leave
    query(':leave', [
      style({ opacity: 1 }),
      animate('200ms ease-out', style({ opacity: 0 })),
    ], { optional: true }),
    
    // Animate enter
    query(':enter', [
      style({ opacity: 0 }),
      animate('300ms 100ms ease-in', style({ opacity: 1 })),
    ], { optional: true }),
  ]),
]);

// Slide transition - more dynamic
export const slideAnimation = trigger('routeAnimations', [
  // Home to Details (slide left)
  transition('home => details, home => person', [
    query(':enter, :leave', [
      style({
        position: 'absolute',
        width: '100%',
      }),
    ], { optional: true }),
    group([
      query(':leave', [
        animate('350ms ease-out', style({
          opacity: 0,
          transform: 'translateX(-30px)',
        })),
      ], { optional: true }),
      query(':enter', [
        style({
          opacity: 0,
          transform: 'translateX(30px)',
        }),
        animate('350ms ease-out', style({
          opacity: 1,
          transform: 'translateX(0)',
        })),
      ], { optional: true }),
    ]),
  ]),

  // Details/Person to Home (slide right)
  transition('details => home, person => home', [
    query(':enter, :leave', [
      style({
        position: 'absolute',
        width: '100%',
      }),
    ], { optional: true }),
    group([
      query(':leave', [
        animate('350ms ease-out', style({
          opacity: 0,
          transform: 'translateX(30px)',
        })),
      ], { optional: true }),
      query(':enter', [
        style({
          opacity: 0,
          transform: 'translateX(-30px)',
        }),
        animate('350ms ease-out', style({
          opacity: 1,
          transform: 'translateX(0)',
        })),
      ], { optional: true }),
    ]),
  ]),

  // Details to Player (zoom in)
  transition('details => player, person => player', [
    query(':enter, :leave', [
      style({
        position: 'absolute',
        width: '100%',
      }),
    ], { optional: true }),
    group([
      query(':leave', [
        animate('300ms ease-out', style({
          opacity: 0,
          transform: 'scale(0.95)',
        })),
      ], { optional: true }),
      query(':enter', [
        style({
          opacity: 0,
          transform: 'scale(1.02)',
        }),
        animate('400ms ease-out', style({
          opacity: 1,
          transform: 'scale(1)',
        })),
      ], { optional: true }),
    ]),
  ]),

  // Player to Details (zoom out)
  transition('player => details, player => home, player => person', [
    query(':enter, :leave', [
      style({
        position: 'absolute',
        width: '100%',
      }),
    ], { optional: true }),
    group([
      query(':leave', [
        animate('250ms ease-out', style({
          opacity: 0,
        })),
      ], { optional: true }),
      query(':enter', [
        style({
          opacity: 0,
          transform: 'scale(0.98)',
        }),
        animate('350ms ease-out', style({
          opacity: 1,
          transform: 'scale(1)',
        })),
      ], { optional: true }),
    ]),
  ]),

  // Default transition for any other route changes
  transition('* <=> *', [
    query(':enter, :leave', [
      style({
        position: 'absolute',
        width: '100%',
      }),
    ], { optional: true }),
    group([
      query(':leave', [
        animate('250ms ease-out', style({ opacity: 0 })),
      ], { optional: true }),
      query(':enter', [
        style({ opacity: 0 }),
        animate('300ms 50ms ease-in', style({ opacity: 1 })),
      ], { optional: true }),
    ]),
  ]),
]);
