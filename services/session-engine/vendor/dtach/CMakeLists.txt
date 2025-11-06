# CMakeLists.txt for dtach
# Reproducible cross-platform build for AI Maestro session engine

cmake_minimum_required(VERSION 3.15)
project(dtach VERSION 0.9 LANGUAGES C)

# Compiler flags
set(CMAKE_C_STANDARD 99)
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -Wall -Wextra")
set(CMAKE_C_FLAGS_RELEASE "${CMAKE_C_FLAGS_RELEASE} -O2")

# Platform detection
if(APPLE)
    add_compile_definitions(_DARWIN_C_SOURCE)
elseif(UNIX)
    add_compile_definitions(_GNU_SOURCE)
endif()

# Source files
set(DTACH_SOURCES
    main.c
    attach.c
    master.c
)

# Executable
add_executable(dtach ${DTACH_SOURCES})

# Link libraries (only what's needed)
if(APPLE)
    # macOS: util library for forkpty
    find_library(UTIL_LIB util REQUIRED)
    target_link_libraries(dtach ${UTIL_LIB})
elseif(UNIX)
    # Linux: util library for forkpty
    target_link_libraries(dtach util)
endif()

# Installation
install(TARGETS dtach RUNTIME DESTINATION bin)

# Strip binary in release mode
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    add_custom_command(TARGET dtach POST_BUILD
        COMMAND ${CMAKE_STRIP} $<TARGET_FILE:dtach>
        COMMENT "Stripping dtach binary"
    )
endif()
