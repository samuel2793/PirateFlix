import { Routes } from '@angular/router';
import { HomeComponent } from './features/home/home';
import { DetailsComponent } from './features/details/details';
import { PlayerComponent } from './features/player/player';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'details/:type/:id', component: DetailsComponent },
  { path: 'play/:type/:id', component: PlayerComponent },
  { path: 'play/:type/:id/:season/:episode', component: PlayerComponent },
  { path: '**', redirectTo: '' },
];
