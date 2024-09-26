export default {
	"main.autostart": true,
	"main.title": "Live Streamer",
	"main.description": "Handles all sessions, playlists and most of the media processing.",
	"main.logo_path": "assets/logo.png",
	"main.autosave_interval": 30,
	"main.autosaves_limit": 256,
	"main.playlist_update_interval": 5, // 5 secs between each media file
	"main.youtube_dl": "yt-dlp",
	"main.youtube_dl_format": "bestvideo[ext=mp4][height<=?1080][vcodec*=avc1]+bestaudio[ext=m4a][acodec*=mp4a]/best[ext=mp4]/best",
	"main.download_expire_days": 180, // 180 days
	"main.session-order-client": true,
	"main.plugins": [],
	"main.targets": [],
	"main.inspect": "",
}