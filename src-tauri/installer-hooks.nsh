!macro customUnInstall
  ; 제거 시 설정 및 캐시 삭제 여부 묻기 (기본값: 아니요)
  MessageBox MB_YESNO|MB_ICONQUESTION "PrismView의 설정 및 썸네일·도면 변환 캐시를 함께 삭제하시겠습니까?$\r$\n$\r$\n'예(Y)': 모든 개인 설정과 캐시를 완전히 삭제합니다.$\r$\n'아니요(N)' (기본값): 다음 설치 시 설정을 유지하기 위해 보존합니다." /SD IDNO IDNO skip_cleanup
    RMDir /r "$APPDATA\PrismView"
    RMDir /r "$LOCALAPPDATA\PrismView"
    RMDir /r "$APPDATA\k-boda"
    RMDir /r "$LOCALAPPDATA\k-boda"
  skip_cleanup:
!macroend
