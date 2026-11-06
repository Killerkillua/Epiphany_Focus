; 桌面快捷方式显式指向安装目录内 icon.ico，避免仅依赖 exe 内嵌图标时的缓存/继承问题。
!macro customInstall
  ; extraResources 将 icon.ico 放到 $INSTDIR\resources\icon.ico
  ; asarUnpack 另有 app.asar.unpacked\resources\icon.ico 作兜底
  StrCpy $0 "$INSTDIR\resources\icon.ico"
  IfFileExists "$0" +2 0
    StrCpy $0 "$INSTDIR\resources\app.asar.unpacked\resources\icon.ico"
  IfFileExists "$0" 0 done_icon_shortcut
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$0" 0
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$0" 0
  done_icon_shortcut:
!macroend
