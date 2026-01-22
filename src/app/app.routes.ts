import { Routes } from '@angular/router';
import { HomeComponent } from './features/home/home';
import { DetailsComponent } from './features/details/details';
import { PlayerComponent } from './features/player/player';
import { PersonComponent } from './features/person/person';
import { ProfileComponent } from './features/profile/profile';
import { SettingsComponent } from './features/settings/settings';

export const routes: Routes = [
  { path: '', component: HomeComponent, data: { animation: 'home' } },
  { path: 'details/:type/:id', component: DetailsComponent, data: { animation: 'details' } },
  { path: 'person/:id', component: PersonComponent, data: { animation: 'person' } },
  { path: 'play/:type/:id', component: PlayerComponent, data: { animation: 'player' } },
  { path: 'play/:type/:id/:season/:episode', component: PlayerComponent, data: { animation: 'player' } },
  { path: 'profile', component: ProfileComponent, data: { animation: 'profile' } },
  { path: 'settings', component: SettingsComponent, data: { animation: 'settings' } },
  { path: '**', redirectTo: '' },
];
