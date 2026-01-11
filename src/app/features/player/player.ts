import { Component, inject, signal, ElementRef, ViewChild, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { AlertController } from '@ionic/angular/standalone';
import { HttpClient } from '@angular/common/http';

type MediaType = 'movie' | 'tv';

interface TorrentFile {
  index: number;
  name: string;
  length: number;
}

interface TorrentInfo {
  infoHash: string;
  name: string;
  files: TorrentFile[];
  progress?: number;
  downloadSpeed?: number;
  numPeers?: number;
}

@Component({
  selector: 'app-player',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './player.html',
  styleUrl: './player.scss',
})
export class PlayerComponent implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly alertController = inject(AlertController);
  private readonly http = inject(HttpClient);

  @ViewChild('videoPlayer', { static: false }) videoPlayer!: ElementRef<HTMLVideoElement>;

  type = signal<MediaType>('movie');
  id = signal<number>(0);
  season = signal<number | null>(null);
  episode = signal<number | null>(null);

  showPlayer = signal<boolean>(false);
  loading = signal<boolean>(false);
  loadingProgress = signal<number>(0);
  errorMessage = signal<string>('');
  videoSrc = signal<string>('');

  private readonly API_URL = 'http://localhost:3001/api';
  private currentTorrentHash: string | null = null;
  private progressInterval: any = null;

  async ngOnInit() {
    const type = this.route.snapshot.paramMap.get('type') as MediaType | null;
    const idStr = this.route.snapshot.paramMap.get('id');
    const seasonStr = this.route.snapshot.paramMap.get('season');
    const episodeStr = this.route.snapshot.paramMap.get('episode');

    if (type === 'movie' || type === 'tv') this.type.set(type);
    if (idStr) this.id.set(Number(idStr));
    if (seasonStr) this.season.set(Number(seasonStr));
    if (episodeStr) this.episode.set(Number(episodeStr));

    await this.promptForMagnetLink();
  }
  async promptForMagnetLink() {
    const alert = await this.alertController.create({
      header: 'Magnet Link',
      message: 'Introduce el magnet link para reproducir el video:',
      inputs: [
        {
          name: 'magnetLink',
          type: 'url',
          placeholder: 'magnet:?xt=urn:btih:...',
          attributes: {
            required: true,
          },
        },
      ],
      buttons: [
        {
          text: 'Cancelar',
          role: 'cancel',
        },
        {
          text: 'Reproducir',
          handler: (data) => {
            if (data.magnetLink && data.magnetLink.trim()) {
              this.loadMagnetLink(data.magnetLink.trim());
              return true;
            }
            return false;
          },
        },
      ],
      backdropDismiss: false,
    });

    await alert.present();
  }

  async loadMagnetLink(magnetUri: string) {
    this.loading.set(true);
    this.errorMessage.set('');
    this.showPlayer.set(true);

    try {
      console.log('Enviando torrent al backend:', magnetUri);

      // Agregar torrent en el backend
      const response = await fetch(`${this.API_URL}/torrent/add`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ magnetUri }),
      });

      if (!response.ok) {
        throw new Error('Error al agregar torrent en el backend');
      }

      const torrentInfo: TorrentInfo = await response.json();
      this.currentTorrentHash = torrentInfo.infoHash;

      console.log('Torrent agregado:', torrentInfo.name);
      console.log('InfoHash:', torrentInfo.infoHash);
      console.log('Archivos:', torrentInfo.files.length);

      // Buscar el archivo de video más grande
      const videoFile = torrentInfo.files.find((file) => {
        const ext = file.name.toLowerCase();
        return (
          ext.endsWith('.mp4') ||
          ext.endsWith('.mkv') ||
          ext.endsWith('.avi') ||
          ext.endsWith('.webm') ||
          ext.endsWith('.mov')
        );
      }) || torrentInfo.files.reduce((prev, current) =>
        (prev.length > current.length ? prev : current)
      );

      if (!videoFile) {
        throw new Error('No se encontró archivo de video en el torrent');
      }

      console.log('Archivo seleccionado:', videoFile.name);

      // Construir URL de streaming
      const streamUrl = `${this.API_URL}/stream/${torrentInfo.infoHash}/${videoFile.index}`;
      this.videoSrc.set(streamUrl);

      console.log('URL de streaming:', streamUrl);

      // Iniciar monitoreo de progreso
      this.startProgressMonitoring();

      this.loading.set(false);

    } catch (error: any) {
      console.error('Error al cargar magnet link:', error);
      this.errorMessage.set(`Error: ${error.message || 'Error desconocido'}`);
      this.loading.set(false);
    }
  }

  startProgressMonitoring() {
    if (!this.currentTorrentHash) return;

    // Actualizar progreso cada segundo
    this.progressInterval = setInterval(async () => {
      try {
        const response = await fetch(`${this.API_URL}/torrent/${this.currentTorrentHash}`);
        if (response.ok) {
          const info: TorrentInfo = await response.json();
          const progress = Math.round((info.progress || 0) * 100);
          this.loadingProgress.set(progress);

          if (progress % 10 === 0 && progress > 0) {
            console.log(`Progreso: ${progress}% | Peers: ${info.numPeers} | Velocidad: ${Math.round((info.downloadSpeed || 0) / 1024)} KB/s`);
          }
        }
      } catch (error) {
        console.error('Error al obtener progreso:', error);
      }
    }, 1000);
  }

  ngOnDestroy() {
    // Limpiar interval de progreso
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }

    // Opcional: eliminar torrent del backend al salir
    if (this.currentTorrentHash) {
      fetch(`${this.API_URL}/torrent/${this.currentTorrentHash}`, {
        method: 'DELETE',
      }).catch(err => console.error('Error al eliminar torrent:', err));
    }
  }
}
