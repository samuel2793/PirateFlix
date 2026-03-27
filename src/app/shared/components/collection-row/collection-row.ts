import { Component, Input, Output, EventEmitter, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatRippleModule } from '@angular/material/core';
import { TranslatePipe } from '../../../shared/pipes/translate.pipe';
import { TmdbService } from '../../../core/services/tmdb';
import { Collection, MediaItem } from '../../../core/services/collections.service';

@Component({
  selector: 'app-collection-row',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatRippleModule,
    TranslatePipe
  ],
  templateUrl: './collection-row.html',
  styleUrl: './collection-row.scss'
})
export class CollectionRowComponent {
  private readonly router = inject(Router);
  private readonly tmdb = inject(TmdbService);

  @Input() collection!: Collection;
  @Input() showRank = false;
  @Input() loading = false;
  
  @Output() viewAll = new EventEmitter<string>();
  @Output() itemClick = new EventEmitter<MediaItem>();

  // Skeleton items for loading state
  skeletonItems = Array(8).fill(0);

  onViewAll() {
    this.viewAll.emit(this.collection?.id);
  }

  onItemClick(item: MediaItem) {
    this.itemClick.emit(item);
    this.router.navigate(['/details', item.media_type, item.id]);
  }

  getTitle(item: MediaItem): string {
    return item.title || item.name || '';
  }

  getYear(item: MediaItem): string {
    const date = item.release_date || item.first_air_date;
    return date ? date.substring(0, 4) : '';
  }

  getPoster(item: MediaItem): string {
    return this.tmdb.posterUrl(item.poster_path) || 'assets/placeholders/placeholder_movie.png';
  }

  navigateToCollection() {
    if (this.collection?.id) {
      this.router.navigate(['/collection', this.collection.id]);
    }
  }
}
