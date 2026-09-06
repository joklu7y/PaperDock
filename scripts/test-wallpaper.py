import os
import sys
import tempfile
import subprocess
import unittest
import asyncio
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import imageio_ffmpeg
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend import wallpaper as w

class WallpaperTests(unittest.TestCase):
    def test_document_priority(self):
        from unittest.mock import Mock
        process = Mock(returncode=None)
        with patch.object(w, 'active_process', process):
            w.cancel_for_document()
        process.kill.assert_called_once()

    def test_cancel(self):
        class Disconnected:
            async def is_disconnected(self): return True
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(w.execute(['-re','-f','lavfi','-i','color=s=320x240','-t','60','-f','null','-'], Disconnected()))
        self.assertEqual(raised.exception.status_code,499)

    def test_dimensions(self):
        self.assertEqual(w.dimensions(3840,2160,False),(1920,1080))
        self.assertEqual(w.dimensions(1280,720,False),(1280,720))
        self.assertEqual(w.dimensions(2160,3840,True),(720,1280))

    def test_real_conversion_and_limits(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, PAPERDOCK_DATA_DIR=temp):
            app=FastAPI(); app.include_router(w.router)
            with TestClient(app) as client:
                path=Path(temp)/'source.mp4'
                subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-v','error','-f','lavfi','-i','color=c=blue:s=3840x2160:r=60','-t','0.3','-c:v','libx264','-threads','2','-preset','ultrafast','-y',str(path)],check=True)
                response=client.post('/wallpaper/video',content=path.read_bytes())
                self.assertEqual(response.status_code,200,response.text)
                token=response.json()['id']
                state=client.get('/wallpaper/status/'+token)
                self.assertEqual(state.status_code,200)
                self.assertEqual(state.json()['state'],'done')
                self.assertEqual(client.get('/wallpaper/videos').json()['videos'][0]['id'],token)
                self.assertEqual(client.get('/wallpaper/video/'+token).status_code,200)
                partial=client.get('/wallpaper/video/'+token,headers={'Range':'bytes=0-127'})
                self.assertEqual(partial.status_code,206)
                self.assertEqual(len(partial.content),128)
                frames=imageio_ffmpeg.read_frames(str(w.directory()/(token+'.mp4')))
                meta=next(frames); frames.close()
                self.assertLessEqual(max(meta['size']),1920)
                self.assertLessEqual(meta['fps'],30)
                low=client.post('/wallpaper/video?low=true',content=path.read_bytes())
                self.assertEqual(low.status_code,200,low.text)
                frames=imageio_ffmpeg.read_frames(str(w.directory()/(low.json()['id']+'.mp4')))
                meta=next(frames); frames.close()
                self.assertEqual(meta['size'],(1280,720))
                self.assertLessEqual(meta['fps'],24)
                self.assertEqual(client.post('/wallpaper/video',content=b'bad').status_code,400)
                with patch.object(w,'MAX_BYTES',2):
                    self.assertEqual(client.post('/wallpaper/video',content=b'abc').status_code,413)
                with patch.object(w,'MAX_SECONDS',.1):
                    self.assertEqual(client.post('/wallpaper/video',content=path.read_bytes()).status_code,400)
                self.assertFalse(list(w.directory().glob('*.upload')))
                self.assertEqual(len(list(w.directory().glob('*.mp4'))),2)
                self.assertEqual(client.delete('/wallpaper/video/'+token).status_code,200)
                self.assertEqual(client.get('/wallpaper/video/'+token).status_code,404)

if __name__=='__main__': unittest.main()
