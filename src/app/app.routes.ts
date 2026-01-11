import { Routes } from '@angular/router';
import { HomeComponent } from './features/home/home';
import { DetailsComponent } from './features/details/details';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'details/:type/:id', component: DetailsComponent },
  { path: '**', redirectTo: '' },
];
