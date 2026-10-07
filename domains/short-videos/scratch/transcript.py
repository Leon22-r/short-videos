from youtube_transcript_api import YouTubeTranscriptApi
file = open("transcript.txt", "w")

video_id = "Pzfle5WWaTo"
ytt_api = YouTubeTranscriptApi()
result = ytt_api.fetch(video_id)
print(result, file=file)