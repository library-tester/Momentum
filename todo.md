# to do
- id number left from checkbox, not below
- collect better ascii graphics (big ones) and images (like your own ones)
- find and analyze other peoples cmd like taskmanagers (like your own tkinter app)

# to do, user management
- ask claude about user management, and ask for a prompt for claude code. the site should be usable for other users once it gets online, every user needs persistent data storage of this tasks and projects, the state of the task manager etc.

# to do, designs
- better daymode, better color palette
- remove designs you dont like

# to do, optional
- a task should be displayed in one line, tags etc. should get to their end
- the scrolling bar in nightmode, just color its border, let the filling empty black color
- add a command to intialize fullscreen in the browser, like clicking F11
- bug: in help file is not everything on a vertical line
- reduce the bload of commands and try to simplify them
- think of some shortcuts of commands, instead of display -d for example
- remove these visible points that show in yet to be seen ascii graphics
- test the application extensively (look for bugs, anything annoying)
- get feedback by AI regarding the whole design and functionality
- download leads to save as instead of immediately downloading
- add a mode where you get a complete image every task
x instead of ascii graphics try it with images, revealing them part by part in a cubic way 
- add different themes
- learn git management
- scrolling bar in darkmode annoying, other color maybe
- on display: enter also leaves it as well as space, exits the fullscreen display
- make display also work with ascii graphics
- i want a much cleaner look of the list. to achieve this remove priority functionality completely, as well as project functionality, due functionality

# ressources
- https://asciiart.website/browse.php
- https://www.asciiart.eu/ascii-art-dictionary?utm_source=chatgpt.com

# other project ideas
- the philosopher guide, webversion (desktop one coming later)


# personal mnemo
git status
git add .
or
git add README.md
git commit -m "Describe your changes"
git push

python3 -m http.server 8000

# if you add/remove/rename files in ascii_art/ or image_art/
# and want double-clicking momentum.html (no server) to see them:
python3 build_art_data.py

# done
x get it to work offline again -> generate art-data.js (python3 build_art_data.py) and have
  momentum.html load it via <script src> instead of fetch(); browsers block fetch()/XHR of
  local files under file://, but not <script src>/<img src> to local files, so this is the
  one case that genuinely can't be avoided rather than a bug — running the http server still
  works exactly as before and doesn't need this step, since fetch() works fine over http.
x remove anything to do with garden from this application and think maybe of another application title
x make it so images are displayed a little bigger so they better fit the screen. Especially vertical oriented images should almost fill the available space so they impress the viewer once they are fully revealed. 
x images should be placed and displayed from the top left corner as starting point, not in the middle of their frame
x add a command where you can see the image in full view (fullscreen, stretched to the outer border of the screen where escape and clicking on the image exits this view). the command can be called "display image" or think of a better command name.
x rm all removes all tasks
x get claude code to work
x remove the icon
x change the format to like in a splitscreen. the commandline is completely from top to bottom on the left side of the screen except the title area which stays on top. the garden or ascii graphic is on the right side of the screen.
x implement the image mode -> images should be stored as png files and if possible jpg jpeg png
x i want to be able to delete tasks by rm 1-4
x archive
x implement a nightmode where everything is red text and design elements on black background (switch nightmode)
x once an image or ascii graphic is finished add a small popup with the title "Image completed" with a download and close button. the download button enables the download of the image


