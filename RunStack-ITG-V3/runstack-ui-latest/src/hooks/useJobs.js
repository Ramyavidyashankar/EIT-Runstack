// src/hooks/useJobs.js
import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchRecentJobs } from '../api/client';

export function useJobs({ status, limit = 20, pollInterval = 15000 } = {}) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchRecentJobs({ limit, status });
      // API returns { jobs: [...] } or just an array
      setJobs(Array.isArray(data) ? data : data.jobs || []);
      setLastFetched(new Date());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [limit, status]);

  useEffect(() => {
    setLoading(true);
    load();
    timerRef.current = setInterval(load, pollInterval);
    return () => clearInterval(timerRef.current);
  }, [load, pollInterval]);

  return { jobs, loading, error, lastFetched, refresh: load };
}