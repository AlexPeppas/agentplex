package store

import (
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestConcurrentDeviceTokenWrites(t *testing.T) {
	s, err := NewSQLiteStore(filepath.Join(t.TempDir(), "relay.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			token, subject := fmt.Sprintf("token-%d", i), fmt.Sprintf("device-%d", i)
			if err := s.StoreRefreshToken(token, subject, time.Now().Add(time.Hour)); err != nil {
				t.Error(err)
				return
			}
			got, err := s.ValidateRefreshToken(token)
			if err != nil || got != subject {
				t.Errorf("token %d: got %q, error %v", i, got, err)
			}
		}(i)
	}
	wg.Wait()
}
