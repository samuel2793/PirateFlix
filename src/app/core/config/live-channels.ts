import { LiveChannel } from '../models/live-channel';

export const LIVE_CHANNELS: readonly LiveChannel[] = [
  {
    id: 'la-1', name: 'La 1', category: 'national', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://pbs.twimg.com/profile_images/2008842210414915584/zIp_go25_200x200.jpg',
    websiteUrl: 'https://www.rtve.es/play/videos/directo/la-1/', epgId: 'La1.TV', geoRestricted: true,
    streams: [
      { label: 'RTVE', url: 'https://rtvelivestream.rtve.es/rtvesec/la1/la1_main_dvr.m3u8', geoRestricted: true },
      { label: 'Emisión alternativa', url: 'https://stream.ads.ottera.tv/playlist.m3u8?network_id=15619' },
    ],
  },
  {
    id: 'la-2', name: 'La 2', category: 'national', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://yt3.googleusercontent.com/ytc/AIdro_kqgHWySi5xprs1VFCNCX0IKNT8yXBLZC43JMoB8j0JUto=s200',
    websiteUrl: 'https://www.rtve.es/play/videos/directo/la-2/', epgId: 'La2.TV', geoRestricted: true,
    streams: [
      { label: 'RTVE', url: 'https://rtvelivestream.rtve.es/rtvesec/la2/la2_main_dvr.m3u8', geoRestricted: true },
      { label: 'Emisión alternativa', url: 'https://d1yebix5w29z3v.cloudfront.net/v1/master/3722c60a815c199d9c0ef36c5b73da68a62b09d1/cc-haqfba85d1gvv/La2ES.m3u8' },
    ],
  },
  {
    id: 'antena-3', name: 'Antena 3', category: 'national', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/antena3/picture?width=200&height=200',
    websiteUrl: 'https://www.atresplayer.com/directos/antena3/', epgId: 'Antena3.TV', geoRestricted: true,
    streams: [
      {
        label: 'Principal',
        geoRestricted: true,
        resolver: { provider: 'atresplayer', pagePath: '/directos/antena3/' },
      },
    ],
  },
  {
    id: 'la-sexta', name: 'La Sexta', category: 'national', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/laSexta/picture?width=200&height=200',
    websiteUrl: 'https://www.atresplayer.com/directos/lasexta/', epgId: 'LaSexta.TV', geoRestricted: true,
    streams: [
      {
        label: 'Principal',
        geoRestricted: true,
        resolver: { provider: 'atresplayer', pagePath: '/directos/lasexta/' },
      },
    ],
  },
  {
    id: 'neox', name: 'Neox', category: 'national', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/Neox/picture?width=200&height=200',
    websiteUrl: 'https://www.atresplayer.com/directos/neox/', geoRestricted: true,
    streams: [
      {
        label: 'Principal',
        geoRestricted: true,
        resolver: { provider: 'atresplayer', pagePath: '/directos/neox/' },
      },
    ],
  },
  {
    id: 'nova', name: 'Nova', category: 'national', countryCode: 'ES', languages: ['es'],
    logoUrl: 'assets/providers/nova.svg',
    websiteUrl: 'https://www.atresplayer.com/directos/nova/', geoRestricted: true,
    streams: [
      {
        label: 'Principal',
        geoRestricted: true,
        resolver: { provider: 'atresplayer', pagePath: '/directos/nova/' },
      },
    ],
  },
  {
    id: 'mega', name: 'Mega', category: 'national', countryCode: 'ES', languages: ['es'],
    logoUrl: 'assets/providers/mega.svg',
    websiteUrl: 'https://www.atresplayer.com/directos/mega/', geoRestricted: true,
    streams: [
      {
        label: 'Principal',
        geoRestricted: true,
        resolver: { provider: 'atresplayer', pagePath: '/directos/mega/' },
      },
    ],
  },
  {
    id: 'atreseries', name: 'Atreseries', category: 'national', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/atreseries/picture?width=200&height=200',
    websiteUrl: 'https://www.atresplayer.com/directos/atreseries/', geoRestricted: true,
    streams: [
      {
        label: 'Principal',
        geoRestricted: true,
        resolver: { provider: 'atresplayer', pagePath: '/directos/atreseries/' },
      },
    ],
  },
  {
    id: 'telecinco', name: 'Telecinco', category: 'national', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://files.mediaset.es/cimg/2026/06/18/logo-black_da39.svg',
    websiteUrl: 'https://www.mediasetinfinity.es/directo/telecinco/', epgId: 'Telecinco.TV', geoRestricted: true,
    streams: [
      {
        label: 'Principal',
        url: 'https://live.tvup.edge2befaster.io/telecincohd/telecincohd.mpd',
        geoRestricted: true,
        drm: {
          keySystem: 'org.w3.clearkey',
          clearKeys: {
        'def5769eed6152d2b32aa1c75a624764': 'ed06df900e0b84549a834c49997dc8ad',
        '7ca93b77733454d3830c60996ad8929b': '8ab9809fc799015a41c39b8b9d6ab9a5',
        'faebbb9b817459d2965625708666a114': '9a1aa94adb0b15b523836c6f41843726'
          },
        },
      },
    ],
  },
  {
    id: 'trece', name: 'TRECE', category: 'national', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/TRECEtves/picture?width=200&height=200',
    websiteUrl: 'https://www.cope.es/directos/trece', epgId: '13.TV',
    streams: [{ label: 'Principal', url: 'https://play.cdn.enetres.net/091DB7AFBD77442B9BA2F141DCC182F5021/021/playlist.m3u8' }],
  },
  {
    id: 'el-toro-tv', name: 'El Toro TV', category: 'national', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/eltorotv.es/picture?width=200&height=200',
    websiteUrl: 'https://eltorotv.com/tv-en-directo', epgId: 'ElToroTV.TV',
    streams: [
      { label: 'Principal', url: 'https://streaming-1.eltorotv.com/lb0/eltorotv-streaming-web/index.m3u8' },
      { label: 'Alternativa', url: 'https://edge-nodo-002.streaming.hitcloser.net/eltorotv-streaming-web/index.m3u8' },
    ],
  },
  {
    id: 'rne-para-todos', name: 'RNE para todos', category: 'national', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/radionacionalrne/picture?width=200&height=200',
    websiteUrl: 'https://www.rtve.es/play/videos/directo/canales-lineales/rne-para-todos/', epgId: 'RNE.TV', geoRestricted: true,
    streams: [
      { label: 'RTVE 1', url: 'https://ztnr.rtve.es/ztnr/6688753.m3u8', geoRestricted: true },
      { label: 'RTVE 2', url: 'https://rtvelivestream.rtve.es/rtvesec/rne/rne_para_todos_main.m3u8', geoRestricted: true },
    ],
  },
  {
    id: '24h', name: '24h', category: 'news', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://pbs.twimg.com/profile_images/1634293543987453954/mb1Rzmso_200x200.jpg',
    websiteUrl: 'https://www.rtve.es/play/videos/directo/24h/', epgId: '24Horas.TV', geoRestricted: true,
    streams: [
      { label: 'RTVE 1', url: 'https://ztnr.rtve.es/ztnr/1694255.m3u8', geoRestricted: true },
      { label: 'RTVE 2', url: 'https://rtvelivestream.rtve.es/rtvesec/24h/24h_main_dvr.m3u8', geoRestricted: true },
      { label: 'Alternativa', url: 'https://dpcj1q84r586o.cloudfront.net/v1/master/3722c60a815c199d9c0ef36c5b73da68a62b09d1/cc-zkqd2yaveiqbt/24HES.m3u8' },
    ],
  },
  {
    id: 'euronews', name: 'Euronews', category: 'news', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/es.euronews/picture?width=200&height=200',
    websiteUrl: 'https://es.euronews.com/live', epgId: 'Euronews.TV',
    streams: [{ label: 'Español', url: 'https://euronews-live-spa-es.fast.rakuten.tv/v1/master/0547f18649bd788bec7b67b746e47670f558b6b2/production-LiveChannel-6571/bitok/eyJzdGlkIjoiMDA0YjY0NTMtYjY2MC00ZTZkLTlkNzEtMTk3YTM3ZDZhZWIxIiwibWt0IjoiZXMiLCJjaCI6NjU3MSwicHRmIjoxfQ==/26034/euronews-es.m3u8' }],
  },
  {
    id: '3cat-info', name: '3Cat Info', category: 'news', countryCode: 'ES', languages: ['ca'],
    logoUrl: 'https://pbs.twimg.com/profile_images/1968163923477098496/blka6O_j_200x200.jpg',
    websiteUrl: 'https://www.3cat.cat/3cat/directes/3catinfo-tv/', epgId: '324.TV',
    streams: [{ label: 'Principal', url: 'https://directes-tv-int.3catdirectes.cat/live-content/canal324-hls/master.m3u8', language: 'ca' }],
  },
  {
    id: 'el-pais', name: 'El País', category: 'news', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/elpais/picture?width=200&height=200',
    websiteUrl: 'https://elpais.com', epgId: 'ElPais.TV',
    streams: [{ label: 'Principal', url: 'https://d2epgk1fomaa1g.cloudfront.net/v1/master/3722c60a815c199d9c0ef36c5b73da68a62b09d1/cc-9n8y4tw0bk3an/live/fast-channel-el-pais/fast-channel-el-pais.m3u8' }],
  },
  {
    id: 'negocios-tv', name: 'Negocios TV', category: 'news', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://pbs.twimg.com/profile_images/1321367703731523584/bNMmbetI_200x200.jpg',
    websiteUrl: 'https://www.negocios.com/directo', epgId: 'Negocios.TV',
    streams: [{ label: 'Principal', url: 'https://negociostv-negociostv-samsunges.amagi.tv/hls/amagi_hls_data_negociost-negociostv-samsunges/CDN/playlist.m3u8' }],
  },
  {
    id: 'el-confidencial', name: 'El Confidencial', category: 'news', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/elconfidencial/picture?width=200&height=200',
    websiteUrl: 'https://www.elconfidencial.com/television/', epgId: 'ElConfidencial.TV',
    streams: [{ label: 'Principal', url: 'https://sis-global.prod.samsungtv.plus/v1/tvpprd/sc-bmo0niz694whx.m3u8' }],
  },
  {
    id: 'teledeporte', name: 'Teledeporte', category: 'sports', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/teledeporteRTVE/picture?width=200&height=200',
    websiteUrl: 'https://www.rtve.es/play/videos/directo/tdp/', epgId: 'TDP.TV', geoRestricted: true,
    streams: [
      { label: 'RTVE', url: 'https://rtvelivestream.rtve.es/rtvesec/tdp/tdp_main.m3u8', geoRestricted: true },
      { label: 'Alternativa', url: 'https://stream.ads.ottera.tv/playlist.m3u8?network_id=15601' },
    ],
  },
  {
    id: 'esport-3', name: 'Esport 3', category: 'sports', countryCode: 'ES', languages: ['ca'],
    logoUrl: 'https://graph.facebook.com/Esport3/picture?width=200&height=200',
    websiteUrl: 'https://www.3cat.cat/3cat/directes/esport3/', epgId: 'E3.TV', geoRestricted: true,
    streams: [
      { label: 'Cataluña', url: 'https://directes-tv-cat.3catdirectes.cat/live-origin/esport3-hls/master.m3u8', language: 'ca', geoRestricted: true },
      { label: 'España', url: 'https://directes-tv-es.3catdirectes.cat/live-origin/esport3-hls/master.m3u8', language: 'ca', geoRestricted: true },
    ],
  },
  {
    id: 'etb-deportes', name: 'ETB Deportes', category: 'sports', countryCode: 'ES', languages: ['es', 'eu'],
    logoUrl: 'https://graph.facebook.com/deportes.eitb.kirolak/picture?width=200&height=200',
    websiteUrl: 'https://kirolakeitb.eus/es/kirolak-360/en-directo/', epgId: 'ETBD.TV',
    streams: [
      { label: 'Evento 1', url: 'https://multimedia.eitb.eus/live-content/oka1hd-hls/master.m3u8' },
      { label: 'Evento 2', url: 'https://multimedia.eitb.eus/live-content/oka2hd-hls/master.m3u8' },
      { label: 'Evento 3', url: 'https://multimedia.eitb.eus/live-content/oka3hd-hls/master.m3u8' },
    ],
  },
  {
    id: 'aragon-deporte', name: 'Aragón Deporte', category: 'sports', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/aragondeporte/picture?width=200&height=200',
    websiteUrl: 'https://www.cartv.es/aragondeporte/directo', epgId: 'AragonD.TV',
    streams: [
      { label: 'Deporte 2', url: 'https://cartv.streaming.aranova.es/hls/live/adeportes_deporte2.m3u8' },
      { label: 'Deporte 1', url: 'https://cartv-streaming.aranova.es/hls/live/adeportes_deporte1.m3u8' },
      { label: 'Deporte 7', url: 'https://cartv-streaming.aranova.es/hls/live/adeportes_deporte7.m3u8' },
      { label: 'Deporte 6', url: 'https://cartv.streaming.aranova.es/hls/live/adeportes_deporte6.m3u8' },
      { label: 'Deporte 5', url: 'https://cartv.streaming.aranova.es/hls/live/adeportes_deporte5.m3u8' },
      { label: 'Deporte 4', url: 'https://cartv.streaming.aranova.es/hls/live/adeportes_deporte4.m3u8' },
      { label: 'Deporte 3', url: 'https://cartv.streaming.aranova.es/hls/live/adeportes_deporte3.m3u8' },
    ],
  },
  {
    id: 'vinx-tv', name: 'Vinx TV', category: 'sports', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/VinxTV/picture?width=200&height=200',
    websiteUrl: 'https://vinxtv.es/en-directo/', epgId: 'Vinx.TV',
    streams: [{ label: 'Principal', url: 'https://live.enfoque.media:5443/live/streams/vinxtv.m3u8' }],
  },
  {
    id: 'real-madrid-tv', name: 'Real Madrid TV', category: 'sports', countryCode: 'ES', languages: ['es', 'en'],
    logoUrl: 'https://graph.facebook.com/RealMadrid/picture?width=200&height=200',
    websiteUrl: 'https://www.realmadrid.com/real-madrid-tv', epgId: 'RMTV.TV', geoRestricted: true,
    streams: [
      { label: 'Español', url: 'https://rmtv.akamaized.net/hls/live/2043153/rmtv-es-web/master.m3u8', language: 'es', geoRestricted: true },
      { label: 'English', url: 'https://rmtv.akamaized.net/hls/live/2043154/rmtv-en-web/master.m3u8', language: 'en' },
    ],
  },
  {
    id: 'top-barca', name: 'Top Barça', category: 'sports', countryCode: 'ES', languages: ['es', 'ca'],
    logoUrl: 'https://graph.facebook.com/fcbarcelona/picture?width=200&height=200',
    websiteUrl: 'https://www.rakuten.tv/es/live_channels/top-barca-es', epgId: 'Top_Barça.TV',
    streams: [
      { label: 'Español', url: 'https://amg17560-fcb-amg17560c2-samsung-es-9803.playouts.now.amagi.tv/ts-eu-w1-n2/playlist/amg17560-fcbarcelona-topbarcaspanish-samsunges/playlist.m3u8', language: 'es' },
      { label: 'Català', url: 'https://amg17560-fcb-amg17560c3-lg-es-11383.playouts.now.amagi.tv/ts-eu-w1-n2/playlist/amg17560-fcbarcelona-topbarcacatala-lges/playlist.m3u8', language: 'ca' },
    ],
  },
  {
    id: 'futsalmafer-tv', name: 'Futsalmafer.tv', category: 'sports', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/futsalmafer.tv/picture?width=200&height=200',
    websiteUrl: 'https://canalsports.tv/directo-24-horas/',
    streams: [{ label: 'Principal', url: 'https://play.agenciastreaming.com:8081/futsalmafertv/index.m3u8' }],
  },
  {
    id: 'clan', name: 'Clan', category: 'kids', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/clantve/picture?width=200&height=200',
    websiteUrl: 'https://www.rtve.es/play/videos/directo/clan/', epgId: 'Clan.TV', geoRestricted: true,
    streams: [
      { label: 'RTVE 1', url: 'https://ztnr.rtve.es/ztnr/5466990.m3u8', geoRestricted: true },
      { label: 'RTVE 2', url: 'https://rtvelivestream.rtve.es/rtvesec/clan/clan_main_dvr.m3u8', geoRestricted: true },
      { label: 'Alternativa', url: 'https://d1wca51iywzyn1.cloudfront.net/v1/master/3722c60a815c199d9c0ef36c5b73da68a62b09d1/cc-e2jakfg63mh4b/ClanES.m3u8' },
    ],
  },
  {
    id: 'sx3', name: 'SX3', category: 'kids', countryCode: 'ES', languages: ['ca'],
    logoUrl: 'https://graph.facebook.com/SomSX3/picture?width=200&height=200',
    websiteUrl: 'https://www.3cat.cat/3cat/directes/sx3/', epgId: 'SX3.TV', geoRestricted: true,
    streams: [
      { label: 'Cataluña', url: 'https://directes-tv-cat.3catdirectes.cat/live-content/super3-hls/master.m3u8', language: 'ca', geoRestricted: true },
      { label: 'España', url: 'https://directes-tv-es.3catdirectes.cat/live-content/super3-hls/master.m3u8', language: 'ca', geoRestricted: true },
    ],
  },
  {
    id: 'infantil-extremadura', name: 'Infantil (Canal Extremadura)', category: 'kids', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/CanalExtremadura/picture?width=200&height=200',
    websiteUrl: 'https://www.canalextremadura.app/videos/354923-canal-tematico-infantil',
    streams: [{ label: 'Principal', url: 'https://cdn-canalextremadura.watchity.net/fast2/master.m3u8' }],
  },
  {
    id: 'pequeradio-tv', name: 'Pequeradio TV', category: 'kids', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/Pequeradio/picture?width=200&height=200',
    websiteUrl: 'https://www.antenita.es',
    streams: [{ label: 'Principal', url: 'https://183.bozztv.com/ssh101/ssh101/pequeradiotv/playlist.m3u8' }],
  },
  {
    id: 'energeek-tv', name: 'EnerGeek TV', category: 'kids', countryCode: 'CL', languages: ['es'],
    logoUrl: 'https://graph.facebook.com/EnerGeekTelevision/picture?width=200&height=200',
    websiteUrl: 'https://energeek.cl/canal/',
    streams: [
      { label: 'Móvil', url: 'https://backend.energeek.cl/webtv/egretro/mobile/index.m3u8?token=W3bEnerG33k2026' },
      { label: 'Web', url: 'https://backend.energeek.cl/webtv/egretroweb/index.m3u8?token=W3bEnerG33k2026' },
    ],
  },
  {
    id: 'dazn-f1', name: 'DAZN F1', category: 'sports', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/3/33/F1.svg',
    websiteUrl: 'https://www.dazn.com/', epgId: 'DAZNF1.TV',
    streams: [
      { label:'DAZN F1 FHDC HEVC', format: 'mpegts', url: 'http://me.mdmfista.com:80/play/live.php?mac=00:1A:79:B7:2C:3B&stream=587368&extension=ts&play_token=AMwxYD2Vge'},
      { label:'DAZN F1 HD', format: 'mpegts', url: 'http://me.mdmfista.com:80/play/live.php?mac=00:1A:79:B7:2C:3B&stream=587361&extension=ts&play_token=4Pk6eafi5F'},
      { label:'DAZN F1 SD', format: 'mpegts', url: 'http://me.mdmfista.com:80/play/live.php?mac=00:1A:79:B7:2C:3B&stream=587360&extension=ts&play_token=V0nqmmLNlq'},
      { label:'DAZN F1 RAW', format: 'mpegts', url: 'http://upgrade.ugoiptv.com:80/play/live.php?mac=00:1A:79:84:75:57&stream=2068325&extension=ts&play_token=eJ856kUICz'},
      { label:'DAZN F1 SD 2', format: 'mpegts', url: 'http://upgrade.ugoiptv.com:80/play/live.php?mac=00:1A:79:84:75:57&stream=1547253&extension=ts&play_token=N3lUroARnO'},
      { label:'f1 DAZN', format: 'mpegts', url: 'http://line.linktotv.eu:80/play/live.php?mac=00:1A:79:F1:B0:FD&stream=2068325&extension=ts&play_token=k92nLHzD0B'},
      { label:'DAZN SD', format: 'mpegts', url: 'http://mag.gofast-tv.me:80/play/live.php?mac=00:1A:79:84:75:57&stream=1547253&extension=ts&play_token=8i5FQvouZ5'},
      { label:'dazn f1 fhd', format: 'mpegts', url: 'http://astott21.xyz:80/live/XbknUJShHI/is72nB1nio/1124014.ts' },
      { label:'DAZN F1 SD', format: 'mpegts', url: 'http://astott21.xyz:80/live/XbknUJShHI/is72nB1nio/216711.ts' },
      { label:'DAZN FORMULA 1 SD', format: 'mpegts', url: 'http://astott21.xyz:80/live/XbknUJShHI/is72nB1nio/591077.ts' },
      { label:'DAZN F1', format: 'mpegts', url: 'http://astott21.xyz:80/live/XbknUJShHI/is72nB1nio/1124014.ts' },
      { label:'F1', format: 'mpegts', url: 'http://ocsunpic.duckdns.org:8080/live/Bulent00836turanpaket/e6cNRuMr/456705.ts' },
    ],
  },
  {
    id: 'dazn-mundial', name: 'DAZN Mundial', category: 'sports', countryCode: 'ES', languages: ['es'],
    logoUrl: 'https://image.discovery.indazn.com/eu/v4/onboarding-images/none/sn_70excpe1synn9kadnbppahdn7/fill/center/top/none/80/0/0/png/image/29?brand=dazn',
    websiteUrl: 'https://www.dazn.com/', epgId: 'DAZNMUNDIAL.TV',
    streams: [
      { label:'MUNDIAL FIFA 2026 *C1', format: 'mpegts', url: 'http://rlatinop.com:8880/live/faueazqemn/DakS9wbL9qsb/526169.ts'},
      { label:'MUNDIAL FIFA 2026 *C2', format: 'mpegts', url: 'http://rlatinop.com:8880/live/faueazqemn/DakS9wbL9qsb/526170.ts'},
      { label:'MUNDIAL FIFA 2026 *CANAL 04', format: 'mpegts', url: 'http://rlatinop.com:8880/live/faueazqemn/DakS9wbL9qsb/532986.ts'},
      { label:'MUNDIAL FIFA 2026 DAZN SD', format: 'mpegts', url: 'http://vppyddncr.top:8080/live/vip2681771081203/216242d7166b/158485.ts'},
      { label: 'MUNDIAL FIFA 2026 DAZN02', format: 'mpegts', url: 'http://vppyddncr.top:8080/live/vip2681771081203/216242d7166b/158473.ts'},
      { label: 'MUNDIAL FIFA 2026 DAZN04', format: 'mpegts', url: 'http://vppyddncr.top:8080/live/vip2681771081203/216242d7166b/158482.ts'},
      { label: 'MUNDIAL FIFA 2026 DAZN1', format: 'mpegts', url: 'http://vppyddncr.top:8080/live/vip2681771081203/216242d7166b/158462.ts'},
      { label: 'MUNDIAL FIFA 2026 DAZN1', format: 'mpegts', url: 'http://vppyddncr.top:8080/live/VIP0185176830057658/paf48pt5h6qi/158462.ts'},
      { label: 'MUNDIAL FIFA 2026 FOX', format: 'mpegts', url: 'http://19801-pamela.ott-cdn.me:80/play/live.php?mac=00:1A:79:c8:07:d8&stream=1389481&extension=ts&play_token=CYQdqYfUv3'},
      { label: 'MUNDIAL FIFA 2026 R10', format: 'mpegts', url: 'http://19801-pamela.ott-cdn.me:80/play/live.php?mac=00:1A:79:c8:07:d8&stream=1393000&extension=ts&play_token=IGyHaCdOGk'},
      { label: 'MUNDIAL FIFA 2026 R2', format: 'mpegts', url: 'http://19801-pamela.ott-cdn.me:80/play/live.php?mac=00:1A:79:c8:07:d8&stream=1393008&extension=ts&play_token=pnowa2L6Gj' },
      { label: 'MUNDIAL FIFA 2026 R3', format: 'mpegts', url: 'http://19801-pamela.ott-cdn.me:80/play/live.php?mac=00:1A:79:c8:07:d8&stream=1393007&extension=ts&play_token=q3UsR7ezsm' },
      { label: 'MUNDIAL FIFA 2026 REPLAY1', format: 'mpegts', url: 'http://19801-pamela.ott-cdn.me:80/play/live.php?mac=00:1A:79:c8:07:d8&stream=1393009&extension=ts&play_token=Z7f3sZNwY3' },
      { label: 'MUNDIAL FIFA 2026 TELEMUNDO2', format: 'mpegts', url: 'http://19801-pamela.ott-cdn.me:80/play/live.php?mac=00:1A:79:c8:07:d8&stream=1389479&extension=ts&play_token=0LChGwAjes' },
      { label: 'MUNDIAL FIFA 2026 TIGO', format: 'mpegts', url: 'http://19801-pamela.ott-cdn.me:80/play/live.php?mac=00:1A:79:c8:07:d8&stream=1389541&extension=ts&play_token=0HnK17YSai' },
      { label: 'MUNDIAL FIFA 2026 TSN', format: 'mpegts', url: 'http://19801-pamela.ott-cdn.me:80/play/live.php?mac=00:1A:79:c8:07:d8&stream=1389529&extension=ts&play_token=maZwBjw0TY' },
      { label: 'MUNDIAL FIFA 2026 TSN5', format: 'mpegts', url: 'http://45.139.122.199:2095/play/live.php?mac=00:1A:79:D6:29:3C&stream=2432252&extension=ts&play_token=4DlwGeeTtO' },
      { label: 'MUNDIAL FIFA 2026 VIX1', format: 'mpegts', url: 'http://45.139.122.199:2095/play/live.php?mac=00:1A:79:D6:29:3C&stream=2435240&extension=ts&play_token=gG5XTBD2ld' },
      { label: 'MUNDIAL FIFA 2026 VIX2', format: 'mpegts', url: 'http://45.139.122.199:2095/play/live.php?mac=00:1A:79:D6:29:3C&stream=2435241&extension=ts&play_token=We3kcMyfuw' },
      { label: 'MUNDIAL FIFA 2026 VIX3', format: 'mpegts', url: 'http://45.139.122.199:2095/play/live.php?mac=00:1A:79:D6:29:3C&stream=2435242&extension=ts&play_token=GGQ5JpC1zW' },
      { label: 'MUNDIAL FIFA 2026 VIX4', format: 'mpegts', url: 'http://45.139.122.199:2095/play/live.php?mac=00:1A:79:D6:29:3C&stream=2435243&extension=ts&play_token=XvyhVvYVhH' },
      { label: 'MUNDIAL FIFA 2026 VIX5', format: 'mpegts', url: 'http://45.139.122.199:2095/play/live.php?mac=00:1A:79:D6:29:3C&stream=2435244&extension=ts&play_token=EWjJsMfgnW' },
      { label: 'MUNDIAL FIFA 2026 VIX6', format: 'mpegts', url: 'http://45.139.122.199:2095/play/live.php?mac=00:1A:79:D6:29:3C&stream=2435245&extension=ts&play_token=JKTEIdL1gH' },
      { label: 'MUNDIAL FIFA 2026 WC1', format: 'mpegts', url: 'http://nocable.cc:8080/0jpXVv/455177/325874'},
      { label: 'MUNDIAL FIFA 2026 WC3', format: 'mpegts', url: 'http://nocable.cc:8080/0jpXVv/455177/325876'},
      { label: 'MUNDIAL FIFA 2026 WC4', format: 'mpegts', url: 'http://nocable.cc:8080/0jpXVv/455177/325877'},
      { label: 'MUNDIAL FIFA 2026 WC6', format: 'mpegts', url: 'http://nocable.cc:8080/0jpXVv/455177/326237'},
      { label: 'MUNDIAL FIFA 2026 WIN SPORTS', format: 'mpegts', url: 'http://19801-pamela.ott-cdn.me:80/play/live.php?mac=00:1A:79:c8:07:d8&stream=1389520&extension=ts&play_token=2BgWyTFDRa'},
      { label: 'MUNDIAL FIFA 2026 WIN SPORTS PLUS', format: 'mpegts', url: 'http://19801-pamela.ott-cdn.me:80/play/live.php?mac=00:1A:79:c8:07:d8&stream=1389521&extension=ts&play_token=2BgWyTFDRa'},
      { label: 'MUNDIAL FIFA 2026 TSN1', format: 'mpegts', url: 'http://1.iptv11.is:80/W23605T3731L/c2I0JVPSYw/124954'},
      { label: 'MUNDIAL FIFA 2026 FOX', format: 'mpegts', url: 'http://ln.iptvn.ru/vWD3x'},
      { label: 'MUNDIAL FIFA 2026 TDNUSA', format: 'mpegts', url: 'http://1.iptv11.is:80/W23605T3731L/c2I0JVPSYw/124951'},

    ],
  },
];
