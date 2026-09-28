import { useEffect, useState } from 'react';
import axios from 'axios';
import { apiUrl } from '../config/api.js';

export function usePrivateImage(path) {
  const [image, setImage] = useState(null);
  useEffect(() => {
    let disposed = false;
    let objectUrl;
    if (path) axios.get(path.startsWith('http') ? path : apiUrl(path), { responseType: 'blob' })
      .then(({ data }) => {
        if (!disposed) { objectUrl = URL.createObjectURL(data); setImage({ path, src: objectUrl }); }
      }).catch(() => {});
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [path]);
  return image?.path === path ? image.src : '';
}
