import { renderWidget } from '@remnote/plugin-sdk';
import '../style.css';
import '../App.css';
import { LocalVideoEditorPlayer } from '../components/LocalVideoEditorPlayer';

// Under the title of a video extract: the player of its segment when the
// extract is from a local video (components/LocalVideoEditorPlayer). A
// widget has one powerup filter, hence a second widget for the extracts.
renderWidget(LocalVideoEditorPlayer);
