"""
NDI Receiver Module
Handles NDI source discovery and frame capture via ctypes binding to NDI SDK
"""
import ctypes
import ctypes.util
import os
import sys
import platform
from pathlib import Path
import threading
import time
from dataclasses import dataclass
from io import BytesIO
from typing import List, Optional

import numpy as np
from PIL import Image


class NDIError(RuntimeError):
    pass


def _load_ndi_library() -> ctypes.CDLL:
    """Load NDI SDK library from ndi_receiver_v3__NDI6/lib folder in workspace"""
    
    current_dir = Path(__file__).parent
    workspace_root = current_dir.parent
    ndi_lib_folder = workspace_root / "ndi_receiver_v3__NDI6" / "lib"
    
    if not ndi_lib_folder.exists():
        raise NDIError(f"NDI library folder not found at {ndi_lib_folder}")
    
    candidates = []
    
    if sys.platform == "linux":
        machine = platform.machine()
        if machine == "aarch64":
            candidates.append(ndi_lib_folder / "aarch64-rpi4-linux-gnueabi" / "libndi.so.6")
        elif machine == "armv7l":
            candidates.append(ndi_lib_folder / "arm-rpi4-linux-gnueabihf" / "libndi.so.6")
        elif machine == "x86_64":
            candidates.append(ndi_lib_folder / "x86_64-linux-gnu" / "libndi.so.6")
        elif machine == "i686":
            candidates.append(ndi_lib_folder / "i686-linux-gnu" / "libndi.so.6")
        else:
            candidates.append(ndi_lib_folder / "x86_64-linux-gnu" / "libndi.so.6")
    
    # Add system fallbacks
    if sys.platform == "darwin":
        candidates += [
            "libndi.dylib",
            "/opt/ndi/lib/libndi.dylib",
        ]
    elif sys.platform == "linux":
        candidates += [
            "libndi.so",
            "/opt/ndi/lib/x86_64-linux-gnu/libndi.so.6",
            "/opt/ndi/lib/x86_64-linux-gnu/libndi.so",
        ]
    else:  # Windows
        candidates += [
            "Processing.NDI.Lib.x64.dll",
            "Processing.NDI.Lib.x64",
            r"C:\Program Files\NDI\NDI 6 Runtime\v6\Processing.NDI.Lib.x64.dll",
            r"C:\Program Files\NDI\NDI 6 SDK\Bin\x64\Processing.NDI.Lib.x64.dll",
        ]
    
    # Try each candidate
    for name in candidates:
        try:
            p = Path(name)
            if p.is_absolute() and p.exists():
                try:
                    os.add_dll_directory(str(p.parent))
                except Exception:
                    pass
            return ctypes.CDLL(str(name))
        except OSError:
            pass
    
    # Final fallback: system library search
    found = ctypes.util.find_library("ndi") or ctypes.util.find_library("Processing.NDI.Lib.x64")
    if found:
        try:
            return ctypes.CDLL(found)
        except OSError:
            pass
    
    raise NDIError(
        f"Could not load NDI library. Checked {ndi_lib_folder} and system paths. "
        "Ensure NDI SDK libraries are present in ndi_receiver_v3__NDI6/lib/"
    )


# ---- ctypes definitions ----

class NDIlib_source_t(ctypes.Structure):
    _fields_ = [
        ("p_ndi_name", ctypes.c_char_p),
        ("p_url_address", ctypes.c_char_p),
    ]


class NDIlib_find_create_t(ctypes.Structure):
    _fields_ = [
        ("show_local_sources", ctypes.c_bool),
        ("p_groups", ctypes.c_char_p),
        ("p_extra_ips", ctypes.c_char_p),
    ]


class NDIlib_recv_create_v3_t(ctypes.Structure):
    _fields_ = [
        ("source_to_connect_to", NDIlib_source_t),
        ("color_format", ctypes.c_int),
        ("bandwidth", ctypes.c_int),
        ("allow_video_fields", ctypes.c_bool),
        ("p_ndi_recv_name", ctypes.c_char_p),
    ]


class NDIlib_video_frame_v2_t(ctypes.Structure):
    _fields_ = [
        ("xres", ctypes.c_int),
        ("yres", ctypes.c_int),
        ("FourCC", ctypes.c_int),
        ("frame_rate_N", ctypes.c_int),
        ("frame_rate_D", ctypes.c_int),
        ("picture_aspect_ratio", ctypes.c_float),
        ("frame_format_type", ctypes.c_int),
        ("timecode", ctypes.c_longlong),
        ("p_data", ctypes.POINTER(ctypes.c_uint8)),
        ("line_stride_in_bytes", ctypes.c_int),
        ("p_metadata", ctypes.c_char_p),
        ("timestamp", ctypes.c_longlong),
    ]


# Enums
NDIlib_recv_color_format_e_BGRX_BGRA = 0
NDIlib_recv_bandwidth_e_highest = 0
NDIlib_frame_type_none = 0
NDIlib_frame_type_video = 1


class _NDI:
    """Singleton NDI SDK interface"""
    _instance = None
    _lock = threading.Lock()
    
    def __init__(self):
        self.lib = _load_ndi_library()
        
        # Initialize function signatures
        self.lib.NDIlib_initialize.restype = ctypes.c_bool
        self.lib.NDIlib_initialize.argtypes = []
        
        self.lib.NDIlib_destroy.restype = None
        self.lib.NDIlib_destroy.argtypes = []
        
        # Find functions
        self.lib.NDIlib_find_create_v2.restype = ctypes.c_void_p
        self.lib.NDIlib_find_create_v2.argtypes = [ctypes.POINTER(NDIlib_find_create_t)]
        
        self.lib.NDIlib_find_destroy.restype = None
        self.lib.NDIlib_find_destroy.argtypes = [ctypes.c_void_p]
        
        self.lib.NDIlib_find_wait_for_sources.restype = ctypes.c_bool
        self.lib.NDIlib_find_wait_for_sources.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        
        self.lib.NDIlib_find_get_current_sources.restype = ctypes.POINTER(NDIlib_source_t)
        self.lib.NDIlib_find_get_current_sources.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
        
        # Recv functions
        self.lib.NDIlib_recv_create_v3.restype = ctypes.c_void_p
        self.lib.NDIlib_recv_create_v3.argtypes = [ctypes.POINTER(NDIlib_recv_create_v3_t)]
        
        self.lib.NDIlib_recv_destroy.restype = None
        self.lib.NDIlib_recv_destroy.argtypes = [ctypes.c_void_p]
        
        self.lib.NDIlib_recv_connect.restype = None
        self.lib.NDIlib_recv_connect.argtypes = [ctypes.c_void_p, ctypes.POINTER(NDIlib_source_t)]
        
        self.lib.NDIlib_recv_capture_v2.restype = ctypes.c_int
        self.lib.NDIlib_recv_capture_v2.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(NDIlib_video_frame_v2_t),
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_uint32,
        ]
        
        self.lib.NDIlib_recv_free_video_v2.restype = None
        self.lib.NDIlib_recv_free_video_v2.argtypes = [ctypes.c_void_p, ctypes.POINTER(NDIlib_video_frame_v2_t)]
        
        if not self.lib.NDIlib_initialize():
            raise NDIError("NDIlib_initialize failed")
    
    @classmethod
    def get(cls) -> "_NDI":
        with cls._lock:
            if cls._instance is None:
                cls._instance = _NDI()
            return cls._instance


@dataclass(frozen=True)
class Source:
    name: str
    url: str


class NDISourceFinder:
    """Discover and resolve NDI sources"""
    
    def __init__(self):
        ndi = _NDI.get()
        self._ndi = ndi
        
        settings = NDIlib_find_create_t()
        settings.show_local_sources = True
        settings.p_groups = None
        settings.p_extra_ips = None
        
        self._find = ndi.lib.NDIlib_find_create_v2(ctypes.byref(settings))
        if not self._find:
            raise NDIError("NDIlib_find_create_v2 failed")
        
        self._lock = threading.Lock()
    
    def close(self):
        with self._lock:
            if self._find:
                self._ndi.lib.NDIlib_find_destroy(self._find)
                self._find = None
    
    def list_sources(self, timeout_ms: int = 500) -> List[str]:
        with self._lock:
            if not self._find:
                return []
            
            self._ndi.lib.NDIlib_find_wait_for_sources(self._find, ctypes.c_uint32(timeout_ms))
            count = ctypes.c_uint32(0)
            ptr = self._ndi.lib.NDIlib_find_get_current_sources(self._find, ctypes.byref(count))
            
            out: List[str] = []
            for i in range(int(count.value)):
                s = ptr[i]
                if s.p_ndi_name:
                    out.append(s.p_ndi_name.decode("utf-8", errors="replace"))
            return out
    
    def resolve_source(self, name: str, timeout_ms: int = 500) -> Optional[Source]:
        with self._lock:
            if not self._find:
                return None
            
            self._ndi.lib.NDIlib_find_wait_for_sources(self._find, ctypes.c_uint32(timeout_ms))
            count = ctypes.c_uint32(0)
            ptr = self._ndi.lib.NDIlib_find_get_current_sources(self._find, ctypes.byref(count))
            
            for i in range(int(count.value)):
                s = ptr[i]
                s_name = s.p_ndi_name.decode("utf-8", errors="replace") if s.p_ndi_name else ""
                if s_name == name:
                    url = s.p_url_address.decode("utf-8", errors="replace") if s.p_url_address else ""
                    return Source(name=s_name, url=url)
            return None


class NDIReceiver:
    """Capture frames from NDI source"""
    
    def __init__(self, source_name: str):
        self._ndi = _NDI.get()
        self._finder = NDISourceFinder()
        self._source_name = source_name
        
        self._recv = None
        self._recv_lock = threading.Lock()
        self._closed = False
        
        self._connect_thread = threading.Thread(target=self._connect_loop, daemon=True)
        self._connect_thread.start()
    
    def _connect_loop(self):
        while not self._closed:
            try:
                src = self._finder.resolve_source(self._source_name, timeout_ms=500)
                if src is None:
                    time.sleep(0.25)
                    continue
                
                c_src = NDIlib_source_t(
                    p_ndi_name=src.name.encode("utf-8"),
                    p_url_address=src.url.encode("utf-8") if src.url else None,
                )
                
                settings = NDIlib_recv_create_v3_t()
                settings.source_to_connect_to = c_src
                settings.color_format = NDIlib_recv_color_format_e_BGRX_BGRA
                settings.bandwidth = NDIlib_recv_bandwidth_e_highest
                settings.allow_video_fields = False
                settings.p_ndi_recv_name = b"NDI Backend"
                
                recv = self._ndi.lib.NDIlib_recv_create_v3(ctypes.byref(settings))
                if not recv:
                    time.sleep(0.5)
                    continue
                
                with self._recv_lock:
                    if self._recv:
                        self._ndi.lib.NDIlib_recv_destroy(self._recv)
                    self._recv = recv
                
                time.sleep(1.0)
            except Exception:
                time.sleep(0.5)
    
    def close(self):
        self._closed = True
        with self._recv_lock:
            if self._recv:
                self._ndi.lib.NDIlib_recv_destroy(self._recv)
                self._recv = None
        self._finder.close()
    
    def get_jpeg_frame(
        self,
        timeout_ms: int = 1000,
        jpeg_quality: int = 90,
        output_width: int = 0,
        output_height: int = 0,
    ) -> Optional[bytes]:
        """Capture and encode frame to JPEG"""
        with self._recv_lock:
            recv = self._recv
        
        if not recv:
            return None
        
        video = NDIlib_video_frame_v2_t()
        frame_type = self._ndi.lib.NDIlib_recv_capture_v2(
            recv,
            ctypes.byref(video),
            None,
            None,
            ctypes.c_uint32(timeout_ms),
        )
        
        if frame_type != NDIlib_frame_type_video:
            return None
        
        try:
            xres = int(video.xres)
            yres = int(video.yres)
            stride = int(video.line_stride_in_bytes)
            if xres <= 0 or yres <= 0 or stride <= 0:
                return None
            
            # Copy frame data
            buf = ctypes.string_at(video.p_data, yres * stride)
            arr = np.frombuffer(buf, dtype=np.uint8).reshape((yres, stride))
            arr = arr[:, : xres * 4].reshape((yres, xres, 4))  # BGRA
            
            # Convert BGRA to RGB
            rgb = arr[:, :, 2::-1].copy()
            img = Image.fromarray(rgb, mode="RGB")
            
            # Optional resize
            w = int(output_width or 0)
            h = int(output_height or 0)
            if w and h and (img.width != w or img.height != h):
                img = img.resize((w, h), resample=Image.BILINEAR)
            
            # Encode to JPEG
            out = BytesIO()
            q = int(jpeg_quality)
            q = max(20, min(95, q))
            img.save(out, format="JPEG", quality=q, optimize=True)
            return out.getvalue()
        finally:
            self._ndi.lib.NDIlib_recv_free_video_v2(recv, ctypes.byref(video))
